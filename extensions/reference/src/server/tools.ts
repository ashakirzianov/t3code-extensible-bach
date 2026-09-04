/**
 * The one tool this extension registers.
 *
 * The interesting part is `invocation.caller`: the host resolves the thread,
 * environment, and provider instance itself and attaches them to every
 * invocation. An agent cannot claim to be someone else by writing it into the
 * arguments, so an extension can use the caller identity for authorization
 * without validating anything.
 */
import type { ExtensionToolInvocation, ExtensionToolResult } from "../../protocol/protocol.js";
import type { EchoStore } from "./store.js";

export type EchoToolResult = Omit<ExtensionToolResult, "connectionId">;

export function runEchoTool(store: EchoStore, invocation: ExtensionToolInvocation): EchoToolResult {
  const message =
    typeof invocation.arguments.message === "string" ? invocation.arguments.message : "";
  if (message.length === 0) {
    // A bad argument is a tool error the agent can read and correct, not an
    // exception: the extension stays up and the agent gets a usable message.
    return {
      invocationId: invocation.invocationId,
      content: [{ type: "text", text: 'reference_echo requires a non-empty string "message".' }],
      isError: true,
    };
  }

  const record = store.record(invocation.caller.threadId, message);

  return {
    invocationId: invocation.invocationId,
    content: [
      {
        type: "text",
        text: `Echo #${String(record.id)}: ${message}\nCalled from thread ${invocation.caller.threadId} on ${invocation.caller.providerInstanceId}.`,
      },
    ],
    // Structured content is what a caller should parse; the text above is for
    // the agent to read.
    structuredContent: {
      echoId: record.id,
      message: record.message,
      at: record.at,
      caller: invocation.caller,
      totalEchoes: store.count(),
    },
  };
}
