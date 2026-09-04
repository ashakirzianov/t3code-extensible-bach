// Generated from packages/contracts/src/extensions.ts. Do not edit.
// Copy this file into your extension; it has no dependencies.
// Protocol version 1. Reference: docs/internals/extensions/protocol.md

export type ExtensionWsMethod =
  | "extensions.hello"
  | "extensions.registerTools"
  | "extensions.registerHttpPrefix"
  | "extensions.registerWebEntry"
  | "extensions.setBadge"
  | "extensions.connect"
  | "extensions.respondTool"
  | "extensions.respondHttp";

export type ExtensionBadge =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "dot";
    }
  | {
      readonly kind: "count";
      readonly count: number;
    };

export type ExtensionConnectInput = {
  readonly name: ExtensionName;
};

export type ExtensionConnectionId = string;

export type ExtensionError =
  | ExtensionProtocolMismatchError
  | ExtensionHandshakeRequiredError
  | ExtensionToolNameCollisionError
  | ExtensionUnknownToolError
  | ExtensionUnavailableError
  | ExtensionHttpPrefixCollisionError;

export type ExtensionHandshakeRequiredError = {
  readonly _tag: "ExtensionHandshakeRequiredError";
  readonly method: string;
};

export type ExtensionHelloAck = {
  readonly protocolVersion: ExtensionProtocolVersion;
  readonly hostProtocolVersions: ReadonlyArray<ExtensionProtocolVersion>;
  readonly hostVersion: string;
  readonly environmentId: string;
  readonly extensionPath: ExtensionHostPath;
  readonly dataDirectory: ExtensionHostPath;
};

export type ExtensionHelloInput = {
  readonly protocolVersion: ExtensionProtocolVersion;
  readonly manifest: ExtensionManifest;
};

export type ExtensionHostPath = string;

export type ExtensionHttpBody = {
  readonly encoding: "utf8" | "base64";
  readonly data: string;
};

export type ExtensionHttpHeaders = Readonly<Record<string, string>>;

export type ExtensionHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export type ExtensionHttpPrefix = string;

export type ExtensionHttpPrefixCollisionError = {
  readonly _tag: "ExtensionHttpPrefixCollisionError";
  readonly prefix: ExtensionHttpPrefix;
  readonly owner?: ExtensionName;
};

export type ExtensionHttpRequest = {
  readonly requestId: ExtensionHttpRequestId;
  readonly method: ExtensionHttpMethod;
  readonly path: string;
  readonly query?: string;
  readonly headers: ExtensionHttpHeaders;
  readonly body?: ExtensionHttpBody;
  readonly environmentId: string;
};

export type ExtensionHttpRequestId = string;

export type ExtensionHttpResponse = {
  readonly connectionId: ExtensionConnectionId;
  readonly requestId: ExtensionHttpRequestId;
  readonly status: number;
  readonly headers: ExtensionHttpHeaders;
  readonly body?: ExtensionHttpBody;
};

export type ExtensionInvocationId = string;

export type ExtensionManifest = {
  readonly name: ExtensionName;
  readonly version: string;
  readonly protocolVersion: ExtensionProtocolVersion;
  readonly minHostVersion?: string;
  readonly server: ExtensionServerEntry;
  readonly web?: ExtensionWebEntry;
};

export type ExtensionName = string;

export type ExtensionProtocolMismatchError = {
  readonly _tag: "ExtensionProtocolMismatchError";
  readonly extensionName?: ExtensionName;
  readonly requestedVersion: ExtensionProtocolVersion;
  readonly supportedVersions: ReadonlyArray<ExtensionProtocolVersion>;
};

export type ExtensionProtocolVersion = number;

export type ExtensionRegisterHttpPrefixInput = {
  readonly prefix: ExtensionHttpPrefix;
};

export type ExtensionRegisterHttpPrefixResult = {
  readonly prefix: ExtensionHttpPrefix;
  readonly basePath: string;
};

export type ExtensionRegisterToolsInput = {
  readonly tools: ReadonlyArray<ExtensionToolDefinition>;
};

export type ExtensionRegisterToolsResult = {
  readonly tools: ReadonlyArray<ExtensionToolRegistration>;
};

export type ExtensionRegisterWebEntryInput = {
  readonly web: ExtensionWebEntry;
};

export type ExtensionRelativePath = string;

export type ExtensionServerEntry = {
  readonly entry: ExtensionRelativePath;
};

export type ExtensionSetBadgeInput = {
  readonly badge: ExtensionBadge;
};

export type ExtensionStreamEvent =
  | {
      readonly type: "attached";
      readonly connectionId: ExtensionConnectionId;
    }
  | {
      readonly type: "invokeTool";
      readonly connectionId: ExtensionConnectionId;
      readonly invocation: ExtensionToolInvocation;
    }
  | {
      readonly type: "proxyHttp";
      readonly connectionId: ExtensionConnectionId;
      readonly request: ExtensionHttpRequest;
    };

export type ExtensionToolCaller = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
};

export type ExtensionToolContent =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

export type ExtensionToolDefinition = {
  readonly name: ExtensionToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type ExtensionToolInvocation = {
  readonly invocationId: ExtensionInvocationId;
  readonly name: ExtensionToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly caller: ExtensionToolCaller;
};

export type ExtensionToolName = string;

export type ExtensionToolNameCollisionError = {
  readonly _tag: "ExtensionToolNameCollisionError";
  readonly toolName: ExtensionToolName;
  readonly owner?: ExtensionName;
};

export type ExtensionToolRegistration =
  | {
      readonly status: "accepted";
      readonly name: ExtensionToolName;
    }
  | {
      readonly status: "rejected";
      readonly name: ExtensionToolName;
      readonly reason: ExtensionToolRejectionReason;
      readonly message: string;
    };

export type ExtensionToolRejectionReason =
  | "name-collision"
  | "invalid-input-schema"
  | "unsupported";

export type ExtensionToolResult = {
  readonly connectionId: ExtensionConnectionId;
  readonly invocationId: ExtensionInvocationId;
  readonly content: ReadonlyArray<ExtensionToolContent>;
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
};

export type ExtensionUnavailableError = {
  readonly _tag: "ExtensionUnavailableError";
  readonly extensionName: ExtensionName;
  readonly reason: ExtensionUnavailableReason;
  readonly toolName?: ExtensionToolName;
};

export type ExtensionUnavailableReason = "not-connected" | "stopped" | "restarting" | "timeout";

export type ExtensionUnknownToolError = {
  readonly _tag: "ExtensionUnknownToolError";
  readonly toolName: ExtensionToolName;
  readonly extensionName?: ExtensionName;
};

export type ExtensionWebEntry = {
  readonly entry: ExtensionRelativePath;
  readonly css?: ExtensionRelativePath;
  readonly label: string;
  readonly icon?: ExtensionRelativePath;
};
