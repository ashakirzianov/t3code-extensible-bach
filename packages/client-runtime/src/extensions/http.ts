import {
  extensionHttpBasePath,
  type EnvironmentId,
  type ExtensionHttpPrefix,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpMethod } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { buildEnvironmentAuthHeaders } from "../state/environmentHttpAuth.ts";

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
 * The header builder signs a DPoP proof over the method, so it has to be one of
 * the methods the client's HTTP layer knows. Anything else is the caller's bug
 * and is better rejected here than signed wrong.
 */
const HTTP_METHODS: ReadonlyArray<HttpMethod.HttpMethod> = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

const normaliseMethod = (method: string | undefined): HttpMethod.HttpMethod => {
  const candidate = (method ?? "GET").toUpperCase();
  const known = HTTP_METHODS.find((value) => value === candidate);
  if (known === undefined) throw new ExtensionFetchError(`Unsupported HTTP method ${candidate}.`);
  return known;
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
  const method = normaliseMethod(input.init?.method);
  // DPoP proofs are deliberately not signed here. A DPoP credential means a
  // relay connection, which is cross-origin, and a cross-origin environment
  // cannot load an extension bundle at all under the desktop CSP — so no mount
  // that could call this exists yet. The header builder fails loudly if that
  // ever stops being true, which is the outcome we want over a silent 401.
  const headers = await Effect.runPromise(
    buildEnvironmentAuthHeaders(input.prepared.httpAuthorization, method, url, Option.none()),
  );
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
