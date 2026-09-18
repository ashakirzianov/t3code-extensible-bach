import {
  extensionHttpBasePath,
  type EnvironmentId,
  type ExtensionHttpPrefix,
} from "@t3tools/contracts";
import type { PreparedConnection, PreparedHttpAuthorization } from "../connection/model.ts";
import type { EnvironmentHttpAuthHeaders } from "../state/environmentHttpAuth.ts";

/**
 * The authenticated `fetch` a mounted extension is handed.
 *
 * It reuses the same credential the client already holds for that environment —
 * cookie for a same-origin primary, bearer otherwise — so an extension's HTTP
 * routes are reached exactly the way the rest of the client reaches the server,
 * and remote, relay and tunnel modes need nothing extra from the extension.
 */

export class ExtensionFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionFetchError";
  }
}

/**
 * The credential a mounted extension inherits, as request headers.
 *
 * The client's own `executeAuthenticatedEnvironmentHttpRequest` is not usable
 * here: it drives Effect's HTTP client and returns decoded results, while an
 * extension is handed a browser `fetch` that must yield a real `Response`. So
 * this maps the two credential shapes an extension can ever see, and refuses
 * the third loudly.
 *
 * A DPoP credential means a relay connection, whose HTTP base is somebody
 * else's machine: no client has a backend that may proxy its bundle, so a relay
 * environment's extension cannot be mounted and no mount that could reach this
 * exists. (A desktop client's SSH environment can be — its base is a forwarded
 * loopback port and its credential is a bearer, which this handles.) Signing a
 * proof here would be dead code guessing at a case that cannot occur; failing is
 * the outcome we want if that ever stops being true, over a silent 401.
 */
const extensionAuthHeaders = (
  authorization: PreparedHttpAuthorization | null,
): EnvironmentHttpAuthHeaders => {
  if (authorization === null) return {};
  if (authorization._tag === "Bearer") return { authorization: `Bearer ${authorization.token}` };
  throw new ExtensionFetchError(
    `Extensions cannot be reached over a ${authorization._tag} connection.`,
  );
};

const joinPath = (basePath: string, path: string): string =>
  path.startsWith("/") ? `${basePath}${path}` : `${basePath}/${path}`;

export function extensionRequestUrl(input: {
  readonly httpBaseUrl: string;
  readonly environmentId: EnvironmentId;
  readonly prefix: ExtensionHttpPrefix;
  readonly path: string;
}): string {
  return new URL(
    joinPath(extensionHttpBasePath(input.environmentId, input.prefix), input.path),
    input.httpBaseUrl,
  ).toString();
}

export async function extensionFetch(input: {
  readonly prepared: PreparedConnection;
  readonly environmentId: EnvironmentId;
  readonly prefix: ExtensionHttpPrefix;
  readonly path: string;
  readonly init?: RequestInit | undefined;
  readonly fetchFn?: typeof globalThis.fetch;
}): Promise<Response> {
  const url = extensionRequestUrl({
    httpBaseUrl: input.prepared.httpBaseUrl,
    environmentId: input.environmentId,
    prefix: input.prefix,
    path: input.path,
  });
  const headers = extensionAuthHeaders(input.prepared.httpAuthorization);
  const requestHeaders = new Headers(input.init?.headers);
  if (headers.authorization !== undefined) {
    requestHeaders.set("authorization", headers.authorization);
  }
  if (headers.dpop !== undefined) requestHeaders.set("dpop", headers.dpop);
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  return fetchFn(url, {
    ...input.init,
    headers: requestHeaders,
    // A same-origin primary authenticates with a session cookie and carries no
    // header credential, so the request has to opt into sending it.
    ...(input.prepared.httpAuthorization === null ? { credentials: "include" as const } : {}),
  });
}
