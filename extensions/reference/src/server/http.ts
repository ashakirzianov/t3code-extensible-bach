/**
 * The extension's HTTP surface: a single `GET /status`.
 *
 * The host serves the registered prefix under its own origin and auth, then
 * proxies each request onto the stream. Two consequences worth knowing: remote,
 * relay, and tunnel clients reach this with no extra work, and the extension
 * never opens a port of its own.
 *
 * `path` arrives already stripped of the host's base path, so a route matches
 * against a plain "/status" regardless of where the host mounted the prefix.
 */
import type { ExtensionHttpRequest, ExtensionHttpResponse } from "../../protocol/protocol.js";
import type { EchoStore } from "./store.js";

export type HttpResponse = Omit<ExtensionHttpResponse, "connectionId">;

const json = (requestId: string, status: number, value: unknown): HttpResponse => ({
  requestId,
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  // Bodies are utf8 or base64 so binary survives a JSON wire.
  body: { encoding: "utf8", data: JSON.stringify(value) },
});

export function handleHttpRequest(
  store: EchoStore,
  startedAt: string,
  request: ExtensionHttpRequest,
): HttpResponse {
  const path = request.path.replace(/\/+$/, "") || "/";

  if (path === "/status" && (request.method === "GET" || request.method === "HEAD")) {
    const latest = store.latest();
    return json(request.requestId, 200, {
      name: "reference",
      startedAt,
      environmentId: request.environmentId,
      echoCount: store.count(),
      lastEcho: latest ?? null,
    });
  }

  return json(request.requestId, 404, { error: `No route for ${request.method} ${request.path}` });
}
