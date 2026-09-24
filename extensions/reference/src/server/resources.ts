/**
 * The one resource this extension registers.
 *
 * A resource is the read-only half of what an extension contributes to MCP:
 * the host lists it beside its own `t3code://` resources and forwards each
 * `resources/read` here over the stream. Unlike a tool invocation it carries
 * **no caller** — MCP reads a resource by URI and tells the server nothing
 * about who asked — so anything that has to be scoped to a thread belongs in a
 * tool, which does get `invocation.caller`.
 *
 * The other asymmetry worth knowing: there is no `isError` result. A read that
 * cannot be answered has to go unanswered, and the host turns that into an MCP
 * protocol error. So answer with whatever is true — an empty list is a real
 * answer — and save failing for an actual failure.
 *
 * The answer quotes the URI it was asked for rather than a constant of its
 * own. The host routes by URI and only ever sends one this extension
 * registered, so re-deriving it here would only be a second place to keep in
 * step with the manifest.
 */
import type {
  ExtensionReadResourceRequest,
  ExtensionReadResourceResult,
} from "../../protocol/protocol.js";
import type { EchoStore } from "./store.js";

export type ReadResourceResult = Omit<ExtensionReadResourceResult, "connectionId">;

export function readEchoResource(
  store: EchoStore,
  request: ExtensionReadResourceRequest,
): ReadResourceResult {
  const latest = store.latest();
  return {
    requestId: request.requestId,
    contents: [
      {
        type: "text",
        uri: request.uri,
        mimeType: "application/json",
        text: JSON.stringify({ echoCount: store.count(), lastEcho: latest ?? null }, null, 2),
      },
    ],
  };
}
