import {
  EXTENSION_ASSET_ROUTE_PREFIX,
  EXTENSION_REMOTE_ASSET_ROUTE_PREFIX,
  isExtensionAssetPath,
  loopbackHttpBasePort,
  parseExtensionRemoteAssetPath,
} from "@t3tools/shared/extensionRemoteAssets";

/**
 * Serving a remote environment's extension assets from the desktop app's own
 * origin.
 *
 * The renderer cannot `import()` a bundle that is not same-origin with the page
 * (`docs/internals/extensions/spikes/electron-runtime.md`), and an environment
 * the app reached over SSH lives on a forwarded loopback port. Main is the only
 * backend this client has, and it is the party that opened that port, so it is
 * the one that can hand the renderer a same-origin URL for those bytes.
 *
 * **This is not a relay.** Three locks, and a request has to pass all of them:
 *
 * 1. The path names a *port*, never a URL, and the port must be one this
 *    process opened for an SSH environment and has not closed. An environment
 *    the renderer merely knows about — a relay, a LAN address, a tunnel — is
 *    not in this table and is not reachable.
 * 2. Only `/ext-assets/…` travels. That route is authenticated by the signed
 *    token inside the path and serves files under one extension's own web
 *    directory; the environment's API, its WebSocket and its attachments are
 *    not reachable this way.
 * 3. Only `GET` and `HEAD`, and no header from the renderer is forwarded. The
 *    signed path segment is the whole credential, so the proxy needs no
 *    credential of its own and carries none.
 *
 * It also grants the renderer nothing it did not have: the page may already
 * `fetch` any loopback port (the desktop CSP's `connect-src` allows `http:`),
 * and `hostApi.fetch` does exactly that. What it adds is an *origin* the
 * browser will execute a module from.
 */

/**
 * The ports this process has opened, and where each forwards to. A plain map
 * rather than a service: the protocol handler answering a request is a bare
 * async callback registered with Electron, not an Effect, and this is a cache
 * of the app's own tunnels rather than state anything else reads.
 */
const openEnvironments = new Map<
  number,
  { readonly tunnelId: string; readonly httpBaseUrl: string }
>();

/**
 * Remembered when the tunnel opens and forgotten when it closes — both told by
 * the tunnel manager itself (`SshEnvironmentManagerOptions.onTunnel`), which is
 * the only party that knows when the ssh process died on its own. The map is
 * keyed by the forwarded port, because a port is what the request path names.
 *
 * The lifetime matters more than it looks: a port this app has stopped
 * forwarding is a port some unrelated local service may bind next, and
 * answering for it would hand that service the app's own origin.
 */
export function rememberRemoteEnvironment(input: {
  readonly tunnelId: string;
  readonly httpBaseUrl: string;
}): void {
  const port = loopbackHttpBasePort(input.httpBaseUrl);
  if (port === null) return;
  openEnvironments.set(port, { tunnelId: input.tunnelId, httpBaseUrl: input.httpBaseUrl });
}

/**
 * Forgotten when the tunnel goes, however it went — but only if the port is
 * still that tunnel's.
 *
 * The key is the port and the events are not ordered with each other: a tunnel
 * that died can be reported closed *after* the next tunnel was handed the same
 * ephemeral port, and forgetting on the port alone would take a live
 * environment's interface away. So the id has to match the one that put the
 * entry there; a late `closed` for a superseded tunnel is a no-op.
 */
export function forgetRemoteEnvironment(input: {
  readonly tunnelId: string;
  readonly httpBaseUrl: string;
}): void {
  const port = loopbackHttpBasePort(input.httpBaseUrl);
  if (port === null) return;
  if (openEnvironments.get(port)?.tunnelId !== input.tunnelId) return;
  openEnvironments.delete(port);
}

/** Test seam; the app never needs it. */
export function clearRemoteEnvironments(): void {
  openEnvironments.clear();
}

const lookupOpenEnvironment = (port: number): string | undefined =>
  openEnvironments.get(port)?.httpBaseUrl;

/**
 * The URL a request on the client's own origin forwards to, or `null` if it is
 * not a remote-asset request at all, or names a port this process did not open.
 *
 * The query string is deliberately dropped: a minted asset URL carries none, so
 * anything there would be a parameter nobody sends and nobody should honour.
 */
export function resolveRemoteExtensionAsset(input: {
  readonly method: string;
  readonly pathname: string;
  readonly lookup?: (port: number) => string | undefined;
}): string | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  const parsed = parseExtensionRemoteAssetPath(input.pathname);
  if (parsed === null) return null;
  const lookup = input.lookup ?? lookupOpenEnvironment;
  const httpBaseUrl = lookup(parsed.port);
  if (httpBaseUrl === undefined) return null;
  try {
    return new URL(parsed.assetPath, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * How the forwarded request is made, and the other half of "a port, never a
 * URL".
 *
 * - `redirect: "error"` because a redirect is the far side choosing the
 *   destination. Following one would end the invariant at the first 30x: the
 *   remote could point anywhere, and whatever answered would come back under
 *   this app's own origin, as script. A 30x here is not a thing the asset route
 *   ever answers, so refusing it costs nothing real.
 * - `credentials: "omit"` because the signed token in the path is the whole
 *   credential. Nothing of this app's session may ride along — and a 401 from
 *   the far side must not be one Electron can turn into the app's own `login`
 *   event.
 * - No header from the renderer is copied, for the same reason.
 */
export function extensionAssetProxyRequestInit(method: string): RequestInit {
  return { method, redirect: "error", credentials: "omit" };
}

/**
 * Whether a path is addressed to this proxy at all, however it resolves. A
 * request that is addressed here and refused must 404 rather than fall through
 * to the client's own routing, which would answer an `import()` with the SPA's
 * index.html and turn a refusal into a syntax error.
 */
export function isRemoteExtensionAssetRoute(pathname: string): boolean {
  return pathname.startsWith(`${EXTENSION_REMOTE_ASSET_ROUTE_PREFIX}/`);
}

/**
 * The same bridge, for the environment this app runs itself.
 *
 * The renderer's *primary* environment used to need no bridge at all: the
 * packaged app loaded `t3code://app` from a protocol handler that proxied every
 * path to the local backend, so a page-relative `/ext-assets/…` simply arrived
 * there. Upstream's "allow disabling the local environment" work made the
 * packaged renderer a directory of static files instead, and a static directory
 * has no `/ext-assets`: the import 404s, and a 404 on a module import is a
 * reload loop away from unusable.
 *
 * So the asset route is bridged explicitly, in both serving modes, with the
 * same three locks as the remote path — only `/ext-assets/…`, only `GET` and
 * `HEAD`, no renderer header forwarded — and one fewer degree of freedom: there
 * is no port in the path to vary, because the destination is the one backend
 * this process started.
 */
let primaryBackendHttpBaseUrl: string | null = null;

/**
 * Told by `bootstrap` once the backend's endpoint is resolved, which is later
 * than the protocol handler is registered — the handler is up before there is a
 * backend to name, and upstream now boots a window with no local backend at
 * all. Until this is called (and forever, when the local environment is
 * disabled) the route has nowhere to go and 404s.
 */
export function rememberPrimaryBackend(httpBaseUrl: string): void {
  primaryBackendHttpBaseUrl = httpBaseUrl;
}

/** Test seam, and the way back to "there is no local backend". */
export function forgetPrimaryBackend(): void {
  primaryBackendHttpBaseUrl = null;
}

/**
 * The URL a renderer-origin `/ext-assets/…` forwards to, or `null` when the
 * request is refused or there is no local backend to forward it to.
 *
 * The query string is dropped for the same reason as the remote path: a minted
 * asset URL carries none.
 */
export function resolvePrimaryExtensionAsset(input: {
  readonly method: string;
  readonly pathname: string;
  readonly lookup?: () => string | null;
}): string | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  if (!isExtensionAssetPath(input.pathname)) return null;
  const httpBaseUrl = (input.lookup ?? (() => primaryBackendHttpBaseUrl))();
  if (httpBaseUrl === null) return null;
  try {
    return new URL(input.pathname, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Whether a path is addressed to the primary bridge at all. Same reason as
 * `isRemoteExtensionAssetRoute`: a refusal here must be a 404 rather than the
 * packaged client's index.html, which an `import()` would read as a syntax
 * error instead of a missing module.
 */
export function isPrimaryExtensionAssetRoute(pathname: string): boolean {
  return pathname.startsWith(`${EXTENSION_ASSET_ROUTE_PREFIX}/`);
}
