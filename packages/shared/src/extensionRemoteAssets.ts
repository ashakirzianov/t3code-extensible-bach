/**
 * Where a client serves *another* environment's extension assets under its own
 * origin.
 *
 * An extension's web bundle can only be `import()`ed from the page's own origin
 * — `script-src 'self'` with no fetch-then-evaluate escape hatch
 * (`docs/internals/extensions/spikes/electron-runtime.md`). An environment the
 * desktop app reached over SSH lives at `http://127.0.0.1:<forwarded port>`,
 * which is a different origin from `t3code://app`, so its bundle cannot be
 * mounted directly however well the socket and `hostApi.fetch` work.
 *
 * The desktop app has a backend of its own — the Electron main process — and it
 * is the party that opened the tunnel in the first place. So the renderer asks
 * for the asset under a path on its own origin and main forwards it to the
 * forwarded port. This module is the one definition of that path, so the
 * renderer that builds it and the handler that answers it cannot drift.
 *
 * Two properties are deliberate:
 *
 * - **The path carries a port, not a URL.** There is no parameter an attacker
 *   could point anywhere: the only thing a caller can vary is which loopback
 *   port, and main answers only for ports it opened itself.
 * - **Only the asset route travels.** The remainder has to be an `/ext-assets/`
 *   path, which is authenticated by the signed token in it and serves files
 *   under one extension's web directory and nothing else. The environment's own
 *   API is not reachable this way; the renderer already talks to it directly.
 */

/** The prefix a client mounts another environment's assets under. Two leading underscores keep it out of any route an environment itself serves. */
export const EXTENSION_REMOTE_ASSET_ROUTE_PREFIX = "/__ext-remote";

/** Where an environment serves its own extension assets, signed-token authenticated. */
export const EXTENSION_ASSET_ROUTE_PREFIX = "/ext-assets";

const MAX_PORT = 65535;

export interface ExtensionRemoteAssetRequest {
  /** The loopback port the environment's HTTP base is forwarded to. */
  readonly port: number;
  /** The `/ext-assets/…` path, exactly as the environment minted it. */
  readonly assetPath: string;
}

/**
 * The renderer's URL for one minted asset path. Root-relative on purpose: the
 * page resolves it against its own origin, and a code-split chunk the bundle
 * imports relatively resolves next to the entry, through the same prefix.
 */
export function extensionRemoteAssetPath(input: ExtensionRemoteAssetRequest): string {
  return `${EXTENSION_REMOTE_ASSET_ROUTE_PREFIX}/${input.port}${input.assetPath}`;
}

/**
 * The reverse, as the allow-list: anything this returns `null` for is refused
 * without being looked up. A well-formed answer still has to name a port the
 * client actually opened.
 */
export function parseExtensionRemoteAssetPath(
  pathname: string,
): ExtensionRemoteAssetRequest | null {
  if (!pathname.startsWith(`${EXTENSION_REMOTE_ASSET_ROUTE_PREFIX}/`)) return null;
  const rest = pathname.slice(EXTENSION_REMOTE_ASSET_ROUTE_PREFIX.length + 1);
  const separator = rest.indexOf("/");
  if (separator <= 0) return null;
  const port = parsePort(rest.slice(0, separator));
  if (port === null) return null;
  const assetPath = rest.slice(separator);
  if (!isAllowedAssetPath(assetPath)) return null;
  return { port, assetPath };
}

/**
 * The forwarded port behind an environment's HTTP base, or `null` when that
 * base is not a loopback URL — a relay or a LAN address is somebody else's
 * machine, and the client has no business proxying to it.
 *
 * The same loopback rule the desktop's other SSH bridge calls apply
 * (`resolveLoopbackSshHttpBaseUrl`).
 */
export function loopbackHttpBasePort(httpBaseUrl: string | null): number | null {
  if (httpBaseUrl === null) return null;
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)]$/, "$1");
  if (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost") return null;
  if (url.port === "") return null;
  return parsePort(url.port);
}

function parsePort(value: string): number | null {
  if (!/^[0-9]{1,5}$/.test(value)) return null;
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= MAX_PORT ? port : null;
}

function isAllowedAssetPath(assetPath: string): boolean {
  if (!assetPath.startsWith(`${EXTENSION_ASSET_ROUTE_PREFIX}/`)) return false;
  if (assetPath.includes("\0") || assetPath.includes("\\")) return false;
  // Traversal is checked before any decoding, and on the encoded form too, so
  // neither `..` nor `%2e%2e` can walk out of the asset route.
  const lowered = assetPath.toLowerCase();
  if (lowered.includes("..") || lowered.includes("%2e")) return false;
  return true;
}
