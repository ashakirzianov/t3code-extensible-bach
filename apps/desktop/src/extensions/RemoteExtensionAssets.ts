import {
  EXTENSION_REMOTE_ASSET_ROUTE_PREFIX,
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
const openEnvironments = new Map<string, { readonly port: number; readonly httpBaseUrl: string }>();

/** One SSH target, as a key — the same four fields the tunnel is keyed by. */
export function remoteEnvironmentKey(target: {
  readonly alias: string;
  readonly hostname: string;
  readonly username: string | null;
  readonly port: number | null;
}): string {
  return JSON.stringify([target.alias, target.hostname, target.username, target.port]);
}

/** Remembered when the SSH bridge hands a forwarded base URL to the renderer. */
export function rememberRemoteEnvironment(key: string, httpBaseUrl: string): void {
  const port = loopbackHttpBasePort(httpBaseUrl);
  if (port === null) return;
  openEnvironments.set(key, { port, httpBaseUrl });
}

/** Forgotten when the tunnel goes, so a closed port stops being proxyable. */
export function forgetRemoteEnvironment(key: string): void {
  openEnvironments.delete(key);
}

/** Test seam; the app never needs it. */
export function clearRemoteEnvironments(): void {
  openEnvironments.clear();
}

const lookupOpenEnvironment = (port: number): string | undefined => {
  for (const entry of openEnvironments.values()) {
    if (entry.port === port) return entry.httpBaseUrl;
  }
  return undefined;
};

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
 * Whether a path is addressed to this proxy at all, however it resolves. A
 * request that is addressed here and refused must 404 rather than fall through
 * to the client's own routing, which would answer an `import()` with the SPA's
 * index.html and turn a refusal into a syntax error.
 */
export function isRemoteExtensionAssetRoute(pathname: string): boolean {
  return pathname.startsWith(`${EXTENSION_REMOTE_ASSET_ROUTE_PREFIX}/`);
}
