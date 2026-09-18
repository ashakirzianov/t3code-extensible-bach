import type { EnvironmentId, ExtensionAssetUrlsResult } from "@t3tools/contracts";
import {
  extensionRemoteAssetPath,
  loopbackHttpBasePort,
} from "@t3tools/shared/extensionRemoteAssets";

/**
 * How an extension's web bundle reaches the page, for one environment.
 *
 * The constraint underneath is the desktop CSP: `script-src 'self'` with no
 * `unsafe-eval`, and no fetch-then-evaluate escape hatch, so a bundle can only
 * execute if the browser considers its URL same-origin with the page
 * (`docs/internals/extensions/spikes/electron-runtime.md`). Everything here is
 * about getting the minted asset path onto the page's own origin.
 *
 * Three answers:
 *
 * - **`direct`** — the path `assetUrls` mints is already reachable
 *   page-relative. That is the same-origin case, and the desktop renderer's
 *   *primary* environment.
 * - **`proxied`** — the desktop app reached this environment over SSH, so its
 *   HTTP base is a forwarded loopback port that the Electron main process
 *   opened. Main serves those assets under the renderer's own origin
 *   (`apps/desktop/src/extensions/RemoteExtensionAssets.ts`), and the path
 *   prefix here is where. Only the asset route travels, and only for a port the
 *   app opened itself.
 * - **`unavailable`** — no backend of this client's own can reach it: a plain
 *   browser (app.t3.codes, or a page served by a T3 server, neither of which
 *   knows anything about the client's other environments), or an environment
 *   reached some way other than SSH. The route says so rather than failing
 *   obscurely.
 *
 * **The desktop renderer is the case a plain origin comparison gets wrong.** It
 * does not load the app over http: it loads `t3code://app`, and the protocol
 * handler proxies every path to the primary backend
 * (`apps/desktop/src/electron/ElectronProtocol.ts`, `proxyRequest` re-bases
 * `pathname + search` onto the target origin). So a page-relative
 * `/ext-assets/...` import resolves to `t3code://app/ext-assets/...`, which is
 * the page's own origin — `'self'` covers it, and it reaches the primary
 * backend. Comparing the environment's `httpBaseUrl` (`http://127.0.0.1:3773`)
 * with the renderer's origin (`t3code://app`) says "different origin" and hides
 * the local environment's extensions behind the remote-server message, which is
 * exactly what happened on the first packaged build to run this path.
 *
 * That allowance is scoped to the **primary** environment on purpose: it is the
 * only one the protocol handler proxies to. Every other environment goes
 * through the asset proxy or not at all.
 */
export type ExtensionBundleAccess =
  | { readonly kind: "direct" }
  | { readonly kind: "proxied"; readonly pathPrefix: string }
  | { readonly kind: "unavailable" };

export function resolveExtensionBundleAccess(input: {
  /** The environment's own HTTP base, or null while the connection is being prepared. */
  readonly httpBaseUrl: string | null;
  /** `window.location.href`, for resolving a relative base. */
  readonly rendererHref: string;
  /** `window.location.origin`. */
  readonly rendererOrigin: string;
  /** `window.desktopBridge !== undefined`. */
  readonly isDesktopRenderer: boolean;
  /**
   * Whether this environment is one the desktop app itself dialled over SSH.
   * Nothing else is proxied: an environment the client merely knows a URL for
   * is not one main opened a port to, and asking it to fetch one would make it
   * a relay.
   */
  readonly isSshEnvironment: boolean;
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ExtensionBundleAccess {
  if (isSameOrigin(input.httpBaseUrl, input.rendererHref, input.rendererOrigin)) {
    return { kind: "direct" };
  }
  if (!input.isDesktopRenderer) return { kind: "unavailable" };
  if (input.primaryEnvironmentId !== null && input.environmentId === input.primaryEnvironmentId) {
    return { kind: "direct" };
  }
  if (!input.isSshEnvironment) return { kind: "unavailable" };
  const port = loopbackHttpBasePort(input.httpBaseUrl);
  if (port === null) return { kind: "unavailable" };
  return { kind: "proxied", pathPrefix: extensionRemoteAssetPath({ port, assetPath: "" }) };
}

/**
 * The minted asset paths, on an origin this page can execute from.
 *
 * Only the prefix moves: the signed token, the extension name and the file path
 * are carried through byte for byte, so what the environment authorised is what
 * is asked for — and a Deploy, which mints a new token, still produces a URL the
 * browser and the module registry have never seen.
 */
export function rebaseExtensionAssetUrls(
  access: ExtensionBundleAccess,
  assets: ExtensionAssetUrlsResult,
): ExtensionAssetUrlsResult {
  if (access.kind !== "proxied") return assets;
  const rebase = (path: string) => `${access.pathPrefix}${path}`;
  return {
    ...assets,
    entry: rebase(assets.entry),
    ...(assets.css === undefined ? {} : { css: rebase(assets.css) }),
    ...(assets.icon === undefined ? {} : { icon: rebase(assets.icon) }),
  };
}

function isSameOrigin(
  httpBaseUrl: string | null,
  rendererHref: string,
  rendererOrigin: string,
): boolean {
  if (httpBaseUrl === null) return false;
  try {
    return new URL(httpBaseUrl, rendererHref).origin === rendererOrigin;
  } catch {
    return false;
  }
}
