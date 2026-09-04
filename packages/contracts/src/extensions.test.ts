import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EXTENSION_PROTOCOL_VERSION,
  EXTENSION_WS_METHODS,
  ExtensionBadge,
  ExtensionConnectInput,
  ExtensionError,
  ExtensionHelloAck,
  ExtensionHelloInput,
  ExtensionHttpResponse,
  ExtensionManifest,
  ExtensionProtocolMismatchError,
  ExtensionRegisterHttpPrefixInput,
  ExtensionRegisterHttpPrefixResult,
  ExtensionRegisterToolsInput,
  ExtensionRegisterToolsResult,
  ExtensionRegisterWebEntryInput,
  ExtensionSetBadgeInput,
  ExtensionStreamEvent,
  ExtensionToolResult,
  ExtensionUnavailableError,
  negotiateExtensionProtocolVersion,
} from "./extensions.ts";

/** Decode then encode, asserting the value survives the trip unchanged. */
const roundTrips = <A, I>(schema: Schema.Codec<A, I>, encoded: unknown): void => {
  const decoded = Schema.decodeUnknownSync(schema)(encoded);
  expect(Schema.encodeSync(schema)(decoded)).toStrictEqual(encoded);
};

const manifest = {
  name: "bach",
  version: "1.4.0",
  protocolVersion: EXTENSION_PROTOCOL_VERSION,
  server: { entry: "dist/server.js" },
  web: { entry: "dist/web.js", css: "dist/web.css", label: "Bach" },
} as const;

const connectionId = "conn-1";

const isManifest = Schema.is(ExtensionManifest);
const isRegisterToolsInput = Schema.is(ExtensionRegisterToolsInput);
const isBadge = Schema.is(ExtensionBadge);
const isStreamEvent = Schema.is(ExtensionStreamEvent);
const isHttpResponse = Schema.is(ExtensionHttpResponse);

describe("ExtensionManifest", () => {
  it("round trips a full manifest", () => {
    roundTrips(ExtensionManifest, { ...manifest, minHostVersion: "0.0.38" });
  });

  it("round trips the minimum a server-only extension needs", () => {
    roundTrips(ExtensionManifest, {
      name: "notes",
      version: "0.1.0",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      server: { entry: "index.js" },
    });
  });

  it("rejects names that are not lowercase kebab identifiers", () => {
    for (const name of ["Bach", "bach_1", "bach extension", "-bach", "bach-", "bach--x", ""]) {
      expect(isManifest({ ...manifest, name })).toBe(false);
    }
    expect(isManifest({ ...manifest, name: "bach-2" })).toBe(true);
  });

  it("rejects entry paths that escape the extension folder", () => {
    for (const entry of ["../secrets.js", "/etc/passwd", "dist/../../x.js", "dist\\web.js", ""]) {
      expect(isManifest({ ...manifest, server: { entry } })).toBe(false);
    }
    expect(isManifest({ ...manifest, server: { entry: "dist/nested.entry.js" } })).toBe(true);
  });

  it("rejects a protocol version below the first one", () => {
    expect(isManifest({ ...manifest, protocolVersion: 0 })).toBe(false);
  });
});

describe("handshake and registration messages", () => {
  it("round trips hello in both directions", () => {
    roundTrips(ExtensionHelloInput, {
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      manifest,
    });
    roundTrips(ExtensionHelloAck, {
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      hostProtocolVersions: [EXTENSION_PROTOCOL_VERSION],
      hostVersion: "0.0.38",
      environmentId: "env-1",
      extensionPath: "/Users/dev/.t3/extensions/bach",
      dataDirectory: "/Users/dev/.t3/userdata/extensions/bach",
    });
  });

  it("round trips a tool registration and its per-tool answers", () => {
    roundTrips(ExtensionRegisterToolsInput, {
      tools: [
        {
          name: "spawn_agent",
          description: "Spawn a Bach agent.",
          inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
        },
      ],
    });
    roundTrips(ExtensionRegisterToolsResult, {
      tools: [
        { status: "accepted", name: "spawn_agent" },
        {
          status: "rejected",
          name: "preview_open",
          reason: "name-collision",
          message: "Tool preview_open is already provided by T3 Code.",
        },
      ],
    });
  });

  it("rejects tool names outside the MCP charset", () => {
    const tool = { name: "spawn agent", description: "x", inputSchema: {} };
    expect(isRegisterToolsInput({ tools: [tool] })).toBe(false);
    expect(isRegisterToolsInput({ tools: [{ ...tool, name: "spawn_agent" }] })).toBe(true);
  });

  it("round trips the http prefix, web entry, and badge messages", () => {
    roundTrips(ExtensionRegisterHttpPrefixInput, { prefix: "bach-api" });
    roundTrips(ExtensionRegisterHttpPrefixResult, {
      prefix: "bach-api",
      basePath: "/ext-api/env-1/bach-api",
    });
    roundTrips(ExtensionRegisterWebEntryInput, {
      web: { entry: "dist/web.js", label: "Bach", icon: "dist/icon.svg" },
    });
    for (const badge of [{ kind: "none" }, { kind: "dot" }, { kind: "count", count: 3 }]) {
      roundTrips(ExtensionSetBadgeInput, { badge });
    }
  });

  it("rejects a badge count that is negative", () => {
    expect(isBadge({ kind: "count", count: -1 })).toBe(false);
  });
});

describe("brokered calls", () => {
  it("round trips every host-to-extension stream event", () => {
    roundTrips(ExtensionConnectInput, { name: "bach" });
    roundTrips(ExtensionStreamEvent, { type: "attached", connectionId });
    roundTrips(ExtensionStreamEvent, {
      type: "invokeTool",
      connectionId,
      invocation: {
        invocationId: "inv-1",
        name: "spawn_agent",
        arguments: { prompt: "ship it" },
        caller: {
          environmentId: "env-1",
          threadId: "thread-1",
          providerSessionId: "session-1",
          providerInstanceId: "claude",
        },
      },
    });
    roundTrips(ExtensionStreamEvent, {
      type: "proxyHttp",
      connectionId,
      request: {
        requestId: "req-1",
        method: "POST",
        path: "/agents",
        query: "limit=10",
        headers: { "content-type": "application/json" },
        body: { encoding: "utf8", data: '{"a":1}' },
        environmentId: "env-1",
      },
    });
  });

  it("round trips both answers", () => {
    roundTrips(ExtensionToolResult, {
      connectionId,
      invocationId: "inv-1",
      content: [
        { type: "text", text: "done" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
      isError: false,
      structuredContent: { agentId: "a-1" },
    });
    roundTrips(ExtensionHttpResponse, {
      connectionId,
      requestId: "req-1",
      status: 200,
      headers: { "content-type": "application/json" },
      body: { encoding: "base64", data: "aGk=" },
    });
  });

  it("rejects a proxied path that is not rooted", () => {
    expect(
      isStreamEvent({
        type: "proxyHttp",
        connectionId,
        request: {
          requestId: "req-1",
          method: "GET",
          path: "agents",
          headers: {},
          environmentId: "env-1",
        },
      }),
    ).toBe(false);
  });

  it("rejects an http status outside the valid range", () => {
    expect(
      isHttpResponse({
        connectionId,
        requestId: "req-1",
        status: 99,
        headers: {},
      }),
    ).toBe(false);
  });
});

describe("errors", () => {
  it("round trips through the error union", () => {
    roundTrips(ExtensionError, {
      _tag: "ExtensionProtocolMismatchError",
      requestedVersion: 2,
      supportedVersions: [1],
    });
    roundTrips(ExtensionError, {
      _tag: "ExtensionUnavailableError",
      extensionName: "bach",
      reason: "restarting",
      toolName: "spawn_agent",
    });
  });

  it("says which tool is unavailable, because the agent reads it", () => {
    expect(
      new ExtensionUnavailableError({
        extensionName: "bach",
        reason: "not-connected",
        toolName: "spawn_agent",
      }).message,
    ).toBe("The extension backing spawn_agent (bach) is not running.");
  });
});

describe("negotiateExtensionProtocolVersion", () => {
  it("accepts the version this build ships", () => {
    expect(
      negotiateExtensionProtocolVersion({ requestedVersion: EXTENSION_PROTOCOL_VERSION }),
    ).toStrictEqual(Result.succeed(EXTENSION_PROTOCOL_VERSION));
  });

  it("accepts an older version a multi-version host still speaks", () => {
    expect(
      negotiateExtensionProtocolVersion({ requestedVersion: 1, supportedVersions: [1, 2] }),
    ).toStrictEqual(Result.succeed(1));
  });

  it("fails with the host's list when the version is unknown", () => {
    const result = negotiateExtensionProtocolVersion({
      requestedVersion: 7,
      supportedVersions: [1, 2],
      extensionName: "bach",
    });
    expect(Result.isFailure(result)).toBe(true);
    const error = (result as Result.Failure<never, ExtensionProtocolMismatchError>).failure;
    expect(error).toBeInstanceOf(ExtensionProtocolMismatchError);
    expect(error.supportedVersions).toStrictEqual([1, 2]);
    expect(error.extensionName).toBe("bach");
    expect(error.message).toContain("supported: 1, 2");
  });
});

describe("EXTENSION_WS_METHODS", () => {
  it("namespaces every method so the host can scope them as one group", () => {
    for (const method of Object.values(EXTENSION_WS_METHODS)) {
      expect(method.startsWith("extensions.")).toBe(true);
    }
  });
});
