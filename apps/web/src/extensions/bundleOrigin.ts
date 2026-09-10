import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Whether an extension's web bundle can be loaded for one environment.
 *
 * The constraint underneath is the desktop CSP: `script-src 'self'` with no
 * `unsafe-eval`, and no fetch-then-evaluate escape hatch, so a bundle can only
 * execute if the browser considers its URL same-origin with the page
 * (`docs/internals/extensions/spikes/electron-runtime.md`). A genuinely remote
 * environment's bundle therefore cannot be mounted here yet — proxying it
 * through the local backend is the follow-up.
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
 * only one the protocol handler proxies to. Any other environment in a desktop
 * renderer is as unreachable as it is in a browser, and is refused.
 */
export function canLoadExtensionBundle(input: {
  /** The environment's own HTTP base, or null while the connection is being prepared. */
  readonly httpBaseUrl: string | null;
  /** `window.location.href`, for resolving a relative base. */
  readonly rendererHref: string;
  /** `window.location.origin`. */
  readonly rendererOrigin: string;
  /** `window.desktopBridge !== undefined`. */
  readonly isDesktopRenderer: boolean;
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  if (isSameOrigin(input.httpBaseUrl, input.rendererHref, input.rendererOrigin)) return true;
  return (
    input.isDesktopRenderer &&
    input.primaryEnvironmentId !== null &&
    input.environmentId === input.primaryEnvironmentId
  );
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
