/**
 * Translation between the host's HTTP surface and the extension protocol.
 *
 * Two routes live here, and they exist for different reasons:
 *
 *   - `/ext-api/<environmentId>/<prefix>/*` proxies an ordinary HTTP request
 *     onto the extension's stream. It sits under the host's own origin and
 *     environment auth, which is what lets remote, relay, and tunnel clients
 *     reach an extension with no extra configuration.
 *   - `/ext-assets/<signed>/<name>/<path>` serves the extension's web bundle.
 *     It carries its credential in the path rather than a header because the
 *     client loads the bundle with `import()`, which cannot set one — the same
 *     constraint that made `AssetAccess` sign its URLs.
 *
 * Pure functions here; the router layers are in `ExtensionHttpRoutes.ts`.
 */
import {
  EXTENSION_ASSET_TOKEN_TTL_MS,
  EXTENSION_HTTP_ROUTE_PREFIX,
  EXTENSION_HTTP_BODY_MAX_CHARS,
  type ExtensionHttpBody,
  type ExtensionHttpHeaders,
  type ExtensionHttpMethod,
  type ExtensionName,
  type ExtensionWebEntry,
} from "@t3tools/contracts";
import { EXTENSION_ASSET_ROUTE_PREFIX } from "@t3tools/shared/extensionRemoteAssets";

// The string lives in contracts, where the client builds the same paths from it.
export const EXT_API_ROUTE_PREFIX = EXTENSION_HTTP_ROUTE_PREFIX;
// Likewise shared: a desktop client re-bases this prefix onto its own origin to
// serve a remote environment's assets, and the two must name the same route.
export const EXT_ASSETS_ROUTE_PREFIX = EXTENSION_ASSET_ROUTE_PREFIX;

/**
 * Headers the host owns and must not forward.
 *
 * Hop-by-hop headers describe *this* connection, so passing them on invites a
 * request-smuggling or double-encoding bug. The auth headers are stripped for a
 * different reason: the extension has already been authorised by the host, and
 * forwarding the caller's credential would hand every extension a token it was
 * never granted.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  // Hop-by-hop (RFC 9110 §7.6.1).
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // The host's own credentials.
  "authorization",
  "cookie",
  "dpop",
  // Recomputed by the host when it answers.
  "content-length",
  "host",
]);

/** Response headers the host sets itself; an extension cannot override them. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "set-cookie",
]);

const TEXTUAL_MIME_PATTERN =
  /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded)|[\w.+-]+\/[\w.+-]*\+(?:json|xml)\b)/i;

/** utf8 when the body is text by content type, base64 otherwise. */
export function isTextualContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return TEXTUAL_MIME_PATTERN.test(contentType.split(";", 1)[0]!.trim());
}

export function encodeRequestBody(
  bytes: Uint8Array,
  contentType: string | undefined,
): ExtensionHttpBody {
  return isTextualContentType(contentType)
    ? { encoding: "utf8", data: new TextDecoder().decode(bytes) }
    : { encoding: "base64", data: Buffer.from(bytes).toString("base64") };
}

export function decodeResponseBody(body: ExtensionHttpBody): Uint8Array {
  return body.encoding === "utf8"
    ? new TextEncoder().encode(body.data)
    : new Uint8Array(Buffer.from(body.data, "base64"));
}

/** The contract's cap, measured on the encoded string that crosses the wire. */
export function exceedsBodyCap(body: ExtensionHttpBody): boolean {
  return body.data.length > EXTENSION_HTTP_BODY_MAX_CHARS;
}

export function normalizeRequestHeaders(
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
): ExtensionHttpHeaders {
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(name)) continue;
    normalized[name] = Array.isArray(value) ? value.join(", ") : (value as string);
  }
  return normalized;
}

export function normalizeResponseHeaders(headers: ExtensionHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
    normalized[name] = value;
  }
  return normalized;
}

export interface ParsedExtApiPath {
  readonly environmentId: string;
  readonly prefix: string;
  /** Path *below* the prefix, always leading-slashed. The extension routes on this. */
  readonly path: string;
}

/**
 * Splits `/ext-api/<environmentId>/<prefix>/rest` into its parts.
 *
 * The extension sees only `rest`, so a route matches `/status` wherever the
 * host happened to mount the prefix and the extension never hardcodes the
 * environment id it is running under.
 */
export function parseExtApiPath(pathname: string): ParsedExtApiPath | null {
  if (!pathname.startsWith(`${EXT_API_ROUTE_PREFIX}/`)) return null;
  const rest = pathname.slice(EXT_API_ROUTE_PREFIX.length + 1);
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0) return null;
  const environmentId = decodeURIComponent(rest.slice(0, firstSlash));
  const afterEnvironment = rest.slice(firstSlash + 1);
  const secondSlash = afterEnvironment.indexOf("/");
  const prefix = decodeURIComponent(
    secondSlash === -1 ? afterEnvironment : afterEnvironment.slice(0, secondSlash),
  );
  if (environmentId.length === 0 || prefix.length === 0) return null;
  const path = secondSlash === -1 ? "/" : afterEnvironment.slice(secondSlash);
  return { environmentId, prefix, path: path.startsWith("/") ? path : `/${path}` };
}

const HTTP_METHODS = new Set<ExtensionHttpMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export function toExtensionHttpMethod(method: string): ExtensionHttpMethod | null {
  const upper = method.toUpperCase() as ExtensionHttpMethod;
  return HTTP_METHODS.has(upper) ? upper : null;
}

// ---------------------------------------------------------------------------
// Web assets
// ---------------------------------------------------------------------------

export interface ExtensionAssetClaims {
  readonly version: 1;
  readonly name: ExtensionName;
  readonly expiresAt: number;
}

export function encodeAssetClaims(claims: ExtensionAssetClaims): string {
  return JSON.stringify(claims);
}

export function decodeAssetClaims(payload: string): ExtensionAssetClaims | null {
  try {
    const parsed = JSON.parse(payload) as Partial<ExtensionAssetClaims>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.name !== "string" || parsed.name.length === 0) return null;
    if (typeof parsed.expiresAt !== "number") return null;
    return { version: 1, name: parsed.name, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function assetExpiryFrom(nowMs: number): number {
  return nowMs + EXTENSION_ASSET_TOKEN_TTL_MS;
}

/**
 * The set of relative paths a signed URL may serve.
 *
 * The declared entry, css, and icon plus anything beside the entry: a bundler
 * that code-splits emits sibling chunks the entry imports by relative path, and
 * refusing those would mean the web entry only works when it is a single file.
 * Directory containment is enforced separately by `resolveWebAssetPath`.
 */
export function webAssetDirectory(web: Pick<ExtensionWebEntry, "entry">): string {
  const entry = web.entry.replace(/\\/g, "/");
  const lastSlash = entry.lastIndexOf("/");
  return lastSlash === -1 ? "" : entry.slice(0, lastSlash);
}

/**
 * Resolves a requested asset path against the extension folder, or returns null.
 *
 * Everything served must sit inside the web entry's own directory. Rejecting
 * `..`, absolute paths, and anything that escapes after normalisation is what
 * stops a signed URL from becoming a read primitive over the whole filesystem.
 */
export function resolveWebAssetPath(input: {
  readonly extensionPath: string;
  readonly web: ExtensionWebEntry;
  readonly requestedPath: string;
  readonly join: (...segments: string[]) => string;
  readonly normalize: (value: string) => string;
  readonly isAbsolute: (value: string) => boolean;
}): string | null {
  const requested = input.requestedPath.replace(/\\/g, "/");
  if (requested.length === 0) return null;
  // Reject an absolute path rather than quietly re-reading it as relative.
  // Silently turning "/etc/passwd" into "<web>/etc/passwd" stays contained, but
  // it answers a question the caller did not ask; a 404 is the honest reply.
  if (requested.startsWith("/") || input.isAbsolute(requested) || /^[a-zA-Z]:/.test(requested)) {
    return null;
  }
  // Reject before normalising: a traversal that cancels out is still a caller
  // asking for one, and there is no legitimate reason to send it.
  if (requested.split("/").some((segment) => segment === ".." || segment === ".")) return null;
  if (requested.includes("\0")) return null;

  const directory = webAssetDirectory(input.web);
  const rootDirectory = input.normalize(input.join(input.extensionPath, directory));
  const resolved = input.normalize(input.join(rootDirectory, requested));
  // Containment, belt and braces: the segment check above should already have
  // made this impossible, but a symlink-free string check is cheap.
  const rootWithSeparator = rootDirectory.endsWith("/") ? rootDirectory : `${rootDirectory}/`;
  if (!resolved.startsWith(rootWithSeparator)) return null;
  return resolved;
}

const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  // The module the client `import()`s. The browser refuses to execute a module
  // served as anything but a JavaScript MIME type.
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff: "font/woff",
  woff2: "font/woff2",
};

export function assetContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ASSET_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export interface ParsedExtAssetPath {
  readonly token: string;
  readonly name: string;
  readonly path: string;
}

/** Splits `/ext-assets/<token>/<name>/<path>`. */
export function parseExtAssetPath(pathname: string): ParsedExtAssetPath | null {
  if (!pathname.startsWith(`${EXT_ASSETS_ROUTE_PREFIX}/`)) return null;
  const rest = pathname.slice(EXT_ASSETS_ROUTE_PREFIX.length + 1);
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0) return null;
  const token = rest.slice(0, firstSlash);
  const afterToken = rest.slice(firstSlash + 1);
  const secondSlash = afterToken.indexOf("/");
  if (secondSlash <= 0) return null;
  const name = decodeURIComponent(afterToken.slice(0, secondSlash));
  const path = afterToken.slice(secondSlash + 1);
  if (name.length === 0 || path.length === 0) return null;
  return { token, name, path };
}
