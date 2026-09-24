/**
 * The reference extension's server entry.
 *
 * It exercises every seam in the protocol exactly once, in the order the host
 * expects: hello, then the declarative registrations, then `connect` last —
 * because opening the stream is the readiness signal, and the host may start
 * invoking tools the moment it exists.
 *
 * Read this file top to bottom to see the whole lifecycle of an extension.
 */
import type {
  ExtensionHelloAck,
  ExtensionHttpRequest,
  ExtensionManifest,
  ExtensionReadResourceRequest,
  ExtensionRegisterHttpPrefixResult,
  ExtensionRegisterResourcesResult,
  ExtensionRegisterToolsResult,
  ExtensionStreamEvent,
  ExtensionToolInvocation,
} from "../../protocol/protocol.js";
import { readHostEnvironment, MissingHostEnvironmentError } from "./env.js";
import { RpcClient, RpcConnectionClosedError } from "./rpc.js";
import { EchoStore } from "./store.js";
import { MANIFEST, HTTP_PREFIX, INSTRUCTIONS, RESOURCES, TOOLS, WEB_ENTRY } from "./manifest.js";
import { handleHttpRequest } from "./http.js";
import { readEchoResource } from "./resources.js";
import { runEchoTool } from "./tools.js";

/** Reconnect backoff. The host supervises the process; this only covers a socket blip. */
const RECONNECT_DELAY_MS = 1_000;

async function main(): Promise<void> {
  const env = readHostEnvironment();
  const store = new EchoStore(env.dataDirectory);
  const startedAt = new Date().toISOString();

  // The host holds registrations across a reconnect only for the connection
  // that made them, so a reconnect re-sends all of this verbatim. That is why
  // registration is idempotent and declarative rather than a diff.
  const session = async (): Promise<void> => {
    let reconnect = false;
    const client = await RpcClient.connect({
      url: env.wsUrl,
      token: env.token,
      onClose: (error: RpcConnectionClosedError) => {
        console.error(`[reference] host connection lost: ${error.message}`);
        reconnect = true;
      },
    });

    // 1. Handshake. The host answers with the negotiated version and our paths.
    // The host-assigned name overrides the manifest's own. The token's subject
    // is `extension:<name>`, and a token minted for one extension cannot say
    // hello as another — so the same built folder installed twice must
    // introduce itself as the installation it was spawned for, not as whatever
    // name it was built with. `extensions.connect` is verified against this.
    const manifest: ExtensionManifest = { ...MANIFEST, name: env.name };
    const ack = await client.call<ExtensionHelloAck>("extensions.hello", {
      protocolVersion: manifest.protocolVersion,
      manifest,
    });
    console.log(
      `[reference] connected to host ${ack.hostVersion} (protocol v${String(ack.protocolVersion)}), ` +
        // The directory this process actually writes to, which is the one the
        // host passed at spawn. In dev mode the operator chooses it, so it can
        // differ from the canonical path the host reports in the ack.
        `environment ${ack.environmentId}, data at ${env.dataDirectory}`,
    );

    // 2. Declarative registrations. Each is answered; a rejection is not fatal.
    // `instructions` rides with the tools because it is the same declaration:
    // what this extension is, and what its tools are for. The host appends it
    // to the MCP server's own instructions for every agent in the environment.
    const registered = await client.call<ExtensionRegisterToolsResult>("extensions.registerTools", {
      tools: TOOLS,
      instructions: INSTRUCTIONS,
    });
    for (const entry of registered.tools) {
      if (entry.status === "rejected") {
        // Losing a tool name is survivable: the rest of the extension still runs,
        // and Settings shows the reason. Do not exit.
        console.error(
          `[reference] tool "${entry.name}" rejected (${entry.reason}): ${entry.message}`,
        );
      }
    }

    // Resources are answered per URI, the same way tools are answered per name.
    const registeredResources = await client.call<ExtensionRegisterResourcesResult>(
      "extensions.registerResources",
      { resources: RESOURCES },
    );
    for (const entry of registeredResources.resources) {
      if (entry.status === "rejected") {
        console.error(
          `[reference] resource "${entry.uri}" rejected (${entry.reason}): ${entry.message}`,
        );
      }
    }

    const http = await client.call<ExtensionRegisterHttpPrefixResult>(
      "extensions.registerHttpPrefix",
      { prefix: HTTP_PREFIX },
    );
    console.log(`[reference] HTTP prefix "${http.prefix}" served at ${http.basePath}`);

    await client.call("extensions.registerWebEntry", { web: WEB_ENTRY });

    // The badge is host-held state: set it now so a reconnect restores the
    // count the user was already looking at.
    await client.call("extensions.setBadge", { badge: badgeFor(store.count()) });

    // 3. Open the stream last. This is the readiness signal.
    await new Promise<void>((resolve) => {
      let connectionId: string | undefined;

      client.stream(
        "extensions.connect",
        // The same name we said hello with; the host verifies the match.
        { name: manifest.name },
        (raw) => {
          const event = raw as ExtensionStreamEvent;
          switch (event.type) {
            case "attached":
              // A fresh id per connection: it is how the host drops an answer
              // that arrives from a process it has already given up on.
              connectionId = event.connectionId;
              console.log(`[reference] ready (connection ${event.connectionId})`);
              return;
            case "invokeTool":
              void respondToTool(client, store, connectionId, event.invocation);
              return;
            case "proxyHttp":
              void respondToHttp(client, store, connectionId, startedAt, event.request);
              return;
            case "readResource":
              void respondToReadResource(client, store, connectionId, event.request);
              return;
          }
        },
        (error) => {
          if (error) console.error(`[reference] stream ended: ${String(error)}`);
          resolve();
        },
      );
    });

    client.close();
    // The store deliberately outlives the socket: it is opened once for the
    // process and reused across reconnects. Closing it here and then recursing
    // would hand the next session a closed database.
    if (reconnect) {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
      await session();
    }
  };

  try {
    await session();
  } finally {
    store.close();
  }
}

const badgeFor = (count: number) =>
  count === 0 ? ({ kind: "none" } as const) : ({ kind: "count", count } as const);

/**
 * Answers one `invokeTool`. Every failure is reported as a tool result with
 * `isError`, never as a thrown exception: the agent that called the tool should
 * read what went wrong, and the extension should stay up.
 */
async function respondToTool(
  client: RpcClient,
  store: EchoStore,
  connectionId: string | undefined,
  invocation: ExtensionToolInvocation,
): Promise<void> {
  if (!connectionId) return; // Nothing can be correlated before `attached`.
  try {
    const result = runEchoTool(store, invocation);
    await client.call("extensions.respondTool", { connectionId, ...result });
    // The badge tracks work this extension has actually done.
    await client.call("extensions.setBadge", { badge: badgeFor(store.count()) });
  } catch (error) {
    // Reporting the failure can itself fail if the socket just died. Swallow
    // that: the host already treats a missing answer as the extension being
    // unavailable, and an unhandled rejection here would take the process down.
    await client
      .call("extensions.respondTool", {
        connectionId,
        invocationId: invocation.invocationId,
        content: [{ type: "text", text: `Reference extension failed: ${String(error)}` }],
        isError: true,
      })
      .catch(() => undefined);
  }
}

/**
 * Answers one `readResource`. There is no `isError` shape for a resource, so a
 * failure has to be a *missing* answer: the host times the call out and turns
 * it into an MCP protocol error carrying its own sentence. Nothing useful can
 * be sent back here, which is why this only logs.
 */
async function respondToReadResource(
  client: RpcClient,
  store: EchoStore,
  connectionId: string | undefined,
  request: ExtensionReadResourceRequest,
): Promise<void> {
  if (!connectionId) return;
  try {
    const result = readEchoResource(store, request);
    await client.call("extensions.respondReadResource", { connectionId, ...result });
  } catch (error) {
    console.error(`[reference] failed to read ${request.uri}: ${String(error)}`);
  }
}

/** Answers one `proxyHttp`. Same rule: an error is a 500 response, not a crash. */
async function respondToHttp(
  client: RpcClient,
  store: EchoStore,
  connectionId: string | undefined,
  startedAt: string,
  request: ExtensionHttpRequest,
): Promise<void> {
  if (!connectionId) return;
  try {
    const response = handleHttpRequest(store, startedAt, request);
    await client.call("extensions.respondHttp", { connectionId, ...response });
  } catch (error) {
    await client
      .call("extensions.respondHttp", {
        connectionId,
        requestId: request.requestId,
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: { encoding: "utf8", data: `Reference extension failed: ${String(error)}` },
      })
      .catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  // A missing spawn contract is a human running the entry by hand: explain it
  // without a stack trace. Anything else is a real fault worth the full trace.
  if (error instanceof MissingHostEnvironmentError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
