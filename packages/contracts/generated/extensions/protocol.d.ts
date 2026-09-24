// Generated from packages/contracts/src/extensions.ts. Do not edit.
// Copy this file into your extension; it has no dependencies.
// Protocol version 1. Reference: docs/internals/extensions/protocol.md

export type ExtensionWsMethod =
  | "extensions.hello"
  | "extensions.registerTools"
  | "extensions.registerResources"
  | "extensions.registerHttpPrefix"
  | "extensions.registerWebEntry"
  | "extensions.setBadge"
  | "extensions.connect"
  | "extensions.respondTool"
  | "extensions.respondHttp"
  | "extensions.respondToolsForThread"
  | "extensions.respondReadResource"
  | "extensions.projectIcons"
  | "extensions.generateText";

export interface ExtensionMethodErrors {
  "extensions.hello":
    | ExtensionProtocolMismatchError
    | ExtensionNotFoundError
    | EnvironmentAuthorizationError;
  "extensions.registerTools": ExtensionHandshakeRequiredError | EnvironmentAuthorizationError;
  "extensions.registerResources": ExtensionHandshakeRequiredError | EnvironmentAuthorizationError;
  "extensions.registerHttpPrefix":
    | ExtensionHandshakeRequiredError
    | ExtensionHttpPrefixCollisionError
    | EnvironmentAuthorizationError;
  "extensions.registerWebEntry": ExtensionHandshakeRequiredError | EnvironmentAuthorizationError;
  "extensions.setBadge": ExtensionHandshakeRequiredError | EnvironmentAuthorizationError;
  "extensions.connect": ExtensionHandshakeRequiredError | EnvironmentAuthorizationError;
  "extensions.respondTool": EnvironmentAuthorizationError;
  "extensions.respondHttp": EnvironmentAuthorizationError;
  "extensions.respondToolsForThread": EnvironmentAuthorizationError;
  "extensions.respondReadResource": EnvironmentAuthorizationError;
  "extensions.projectIcons": EnvironmentAuthorizationError;
  "extensions.generateText":
    | ExtensionTextGenerationUnavailableError
    | ExtensionTextGenerationFailedError
    | EnvironmentAuthorizationError;
}

export type EnvironmentAuthorizationError = {
  readonly _tag: "EnvironmentAuthorizationError";
  readonly message: string;
  readonly requiredScope: 
    | "orchestration:read"
    | "orchestration:operate"
    | "terminal:operate"
    | "review:write"
    | "access:read"
    | "access:write"
    | "relay:read"
    | "relay:write"
    | "extension";
};

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
  | ExtensionResourceUriCollisionError
  | ExtensionUnknownResourceError
  | ExtensionUnavailableError
  | ExtensionHttpPrefixCollisionError
  | ExtensionTextGenerationUnavailableError
  | ExtensionTextGenerationFailedError;

export type ExtensionGenerateTextInput = {
  readonly prompt: string;
  readonly system?: string;
};

export type ExtensionGenerateTextResult = {
  readonly text: string;
};

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

export type ExtensionNotFoundError = {
  readonly _tag: "ExtensionNotFoundError";
  readonly extensionName: ExtensionName;
};

export type ExtensionProjectIcon = {
  readonly override: ExtensionProjectIconOverride | null;
  readonly faviconUrl: string | null;
  readonly automatic: {
    readonly text: string;
    readonly color: 
      | "gray"
      | "red"
      | "orange"
      | "amber"
      | "yellow"
      | "lime"
      | "green"
      | "emerald"
      | "teal"
      | "cyan"
      | "sky"
      | "blue"
      | "indigo"
      | "violet"
      | "purple"
      | "fuchsia"
      | "pink"
      | "rose";
    readonly colorCss: ExtensionProjectIconColorCss;
  };
};

export type ExtensionProjectIconColorCss = {
  readonly light: string;
  readonly dark: string;
};

export type ExtensionProjectIconOverride =
  | {
      readonly kind: "lucide";
      readonly name: string;
      readonly color: 
        | "gray"
        | "red"
        | "orange"
        | "amber"
        | "yellow"
        | "lime"
        | "green"
        | "emerald"
        | "teal"
        | "cyan"
        | "sky"
        | "blue"
        | "indigo"
        | "violet"
        | "purple"
        | "fuchsia"
        | "pink"
        | "rose";
      readonly colorCss: ExtensionProjectIconColorCss;
    }
  | {
      readonly kind: "emoji";
      readonly emoji: string;
    }
  | {
      readonly kind: "monogram";
      readonly text: string;
      readonly color: 
        | "gray"
        | "red"
        | "orange"
        | "amber"
        | "yellow"
        | "lime"
        | "green"
        | "emerald"
        | "teal"
        | "cyan"
        | "sky"
        | "blue"
        | "indigo"
        | "violet"
        | "purple"
        | "fuchsia"
        | "pink"
        | "rose";
      readonly colorCss: ExtensionProjectIconColorCss;
    };

export type ExtensionProjectIconsInput = Readonly<Record<string, unknown>> | ReadonlyArray<unknown>;

export type ExtensionProjectIconsResult = {
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly icon: ExtensionProjectIcon;
  }>;
};

export type ExtensionProtocolMismatchError = {
  readonly _tag: "ExtensionProtocolMismatchError";
  readonly extensionName?: ExtensionName;
  readonly requestedVersion: ExtensionProtocolVersion;
  readonly supportedVersions: ReadonlyArray<ExtensionProtocolVersion>;
};

export type ExtensionProtocolVersion = number;

export type ExtensionReadResourceRequest = {
  readonly requestId: ExtensionReadResourceRequestId;
  readonly uri: ExtensionResourceUri;
};

export type ExtensionReadResourceRequestId = string;

export type ExtensionReadResourceResult = {
  readonly connectionId: ExtensionConnectionId;
  readonly requestId: ExtensionReadResourceRequestId;
  readonly contents: ReadonlyArray<ExtensionResourceContents>;
};

export type ExtensionRegisterHttpPrefixInput = {
  readonly prefix: ExtensionHttpPrefix;
};

export type ExtensionRegisterHttpPrefixResult = {
  readonly prefix: ExtensionHttpPrefix;
  readonly basePath: string;
};

export type ExtensionRegisterResourcesInput = {
  readonly resources: ReadonlyArray<ExtensionResourceDefinition>;
};

export type ExtensionRegisterResourcesResult = {
  readonly resources: ReadonlyArray<ExtensionResourceRegistration>;
};

export type ExtensionRegisterToolsInput = {
  readonly tools: ReadonlyArray<ExtensionToolDefinition>;
  readonly filterToolsPerThread?: boolean;
  readonly instructions?: string;
};

export type ExtensionRegisterToolsResult = {
  readonly tools: ReadonlyArray<ExtensionToolRegistration>;
};

export type ExtensionRegisterWebEntryInput = {
  readonly web: ExtensionWebEntry;
};

export type ExtensionRelativePath = string;

export type ExtensionResourceContents =
  | {
      readonly type: "text";
      readonly uri: ExtensionResourceUri;
      readonly mimeType?: string;
      readonly text: string;
    }
  | {
      readonly type: "blob";
      readonly uri: ExtensionResourceUri;
      readonly mimeType?: string;
      readonly blob: string;
    };

export type ExtensionResourceDefinition = {
  readonly uri: ExtensionResourceUri;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
};

export type ExtensionResourceRegistration =
  | {
      readonly status: "accepted";
      readonly uri: ExtensionResourceUri;
    }
  | {
      readonly status: "rejected";
      readonly uri: ExtensionResourceUri;
      readonly reason: ExtensionResourceRejectionReason;
      readonly message: string;
    };

export type ExtensionResourceRejectionReason = "uri-collision" | "unsupported";

export type ExtensionResourceUri = string;

export type ExtensionResourceUriCollisionError = {
  readonly _tag: "ExtensionResourceUriCollisionError";
  readonly uri: ExtensionResourceUri;
  readonly owner?: ExtensionName;
};

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
    }
  | {
      readonly type: "toolsForThread";
      readonly connectionId: ExtensionConnectionId;
      readonly request: ExtensionToolsForThreadRequest;
    }
  | {
      readonly type: "readResource";
      readonly connectionId: ExtensionConnectionId;
      readonly request: ExtensionReadResourceRequest;
    };

export type ExtensionTextGenerationFailedError = {
  readonly _tag: "ExtensionTextGenerationFailedError";
  readonly detail: string;
};

export type ExtensionTextGenerationUnavailableError = {
  readonly _tag: "ExtensionTextGenerationUnavailableError";
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

export type ExtensionToolsForThreadRequest = {
  readonly requestId: ExtensionToolsRequestId;
  readonly threadId: string;
};

export type ExtensionToolsForThreadResult = {
  readonly connectionId: ExtensionConnectionId;
  readonly requestId: ExtensionToolsRequestId;
  readonly tools: ReadonlyArray<ExtensionToolName>;
};

export type ExtensionToolsRequestId = string;

export type ExtensionUnavailableError = {
  readonly _tag: "ExtensionUnavailableError";
  readonly extensionName: ExtensionName;
  readonly reason: ExtensionUnavailableReason;
  readonly toolName?: ExtensionToolName;
  readonly resourceUri?: ExtensionResourceUri;
};

export type ExtensionUnavailableReason = "not-connected" | "stopped" | "restarting" | "timeout";

export type ExtensionUnknownResourceError = {
  readonly _tag: "ExtensionUnknownResourceError";
  readonly uri: ExtensionResourceUri;
  readonly extensionName?: ExtensionName;
};

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
