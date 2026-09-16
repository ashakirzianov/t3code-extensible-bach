import * as Schema from "effect/Schema";

import {
  EXTENSION_PROTOCOL_VERSION,
  EXTENSION_SUPPORTED_PROTOCOL_VERSIONS,
  EXTENSION_WS_METHODS,
  ExtensionBadge,
  ExtensionConnectInput,
  ExtensionError,
  ExtensionGenerateTextInput,
  ExtensionGenerateTextResult,
  ExtensionHelloAck,
  ExtensionHelloInput,
  ExtensionHttpBody,
  ExtensionHttpRequest,
  ExtensionHttpResponse,
  ExtensionManifest,
  ExtensionProjectIconsInput,
  ExtensionProjectIconsResult,
  ExtensionRegisterHttpPrefixInput,
  ExtensionRegisterHttpPrefixResult,
  ExtensionRegisterToolsInput,
  ExtensionRegisterToolsResult,
  ExtensionRegisterWebEntryInput,
  ExtensionSetBadgeInput,
  ExtensionStreamEvent,
  ExtensionToolInvocation,
  ExtensionToolResult,
  ExtensionToolsForThreadRequest,
  ExtensionToolsForThreadResult,
} from "../src/extensions.ts";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import { WsRpcGroup } from "../src/rpc.ts";

/**
 * The vendorable protocol artifacts.
 *
 * `packages/contracts/src/extensions.ts` is the source of truth; this turns it
 * into two files an extension author copies into their own repo — a JSON
 * Schema for authors in any language, and plain TypeScript declarations for
 * the ones writing TypeScript. Both are committed under `generated/` and a
 * test regenerates them and fails on any diff, so the schemas and the
 * published contract cannot drift.
 *
 * The TypeScript is emitted from the JSON Schema rather than from the Effect
 * schemas so that the two artifacts cannot disagree, and so the declarations
 * carry no `effect` dependency into an extension's build.
 */

/** One protocol message, and which schema names describe it. */
interface MethodEntry {
  readonly direction: "extension-to-host" | "host-to-extension";
  readonly summary: string;
  readonly payload?: string;
  readonly success?: string;
  /** Filled from rpc.ts; see `methodErrorNames`. */
  readonly errors?: ReadonlyArray<string>;
}

const METHODS: Readonly<Record<string, MethodEntry>> = {
  [EXTENSION_WS_METHODS.hello]: {
    direction: "extension-to-host",
    summary: "Handshake. Sends the manifest and the protocol version; receives the host's facts.",
    payload: "ExtensionHelloInput",
    success: "ExtensionHelloAck",
  },
  [EXTENSION_WS_METHODS.registerTools]: {
    direction: "extension-to-host",
    summary: "Declares the complete MCP tool surface. Answered per tool.",
    payload: "ExtensionRegisterToolsInput",
    success: "ExtensionRegisterToolsResult",
  },
  [EXTENSION_WS_METHODS.registerHttpPrefix]: {
    direction: "extension-to-host",
    summary: "Claims one path prefix under the host's own origin and auth.",
    payload: "ExtensionRegisterHttpPrefixInput",
    success: "ExtensionRegisterHttpPrefixResult",
  },
  [EXTENSION_WS_METHODS.registerWebEntry]: {
    direction: "extension-to-host",
    summary: "Declares the web bundle and nav entry the host mounts.",
    payload: "ExtensionRegisterWebEntryInput",
  },
  [EXTENSION_WS_METHODS.setBadge]: {
    direction: "extension-to-host",
    summary: "Sets the nav badge. Held by the host across reconnects.",
    payload: "ExtensionSetBadgeInput",
  },
  [EXTENSION_WS_METHODS.connect]: {
    direction: "host-to-extension",
    summary: "Opens the stream the host pushes calls on. Opening it declares the extension ready.",
    payload: "ExtensionConnectInput",
    success: "ExtensionStreamEvent",
  },
  [EXTENSION_WS_METHODS.respondTool]: {
    direction: "extension-to-host",
    summary: "Answers one invokeTool event.",
    payload: "ExtensionToolResult",
  },
  [EXTENSION_WS_METHODS.respondHttp]: {
    direction: "extension-to-host",
    summary: "Answers one proxyHttp event.",
    payload: "ExtensionHttpResponse",
  },
  [EXTENSION_WS_METHODS.respondToolsForThread]: {
    direction: "extension-to-host",
    summary: "Answers one toolsForThread event with the tools that thread may see.",
    payload: "ExtensionToolsForThreadResult",
  },
  [EXTENSION_WS_METHODS.projectIcons]: {
    direction: "extension-to-host",
    summary: "Every project's icon as the host draws it: override, favicon, automatic fallback.",
    payload: "ExtensionProjectIconsInput",
    success: "ExtensionProjectIconsResult",
  },
  [EXTENSION_WS_METHODS.generateText]: {
    direction: "extension-to-host",
    summary: "One question for the environment's configured Text generation model.",
    payload: "ExtensionGenerateTextInput",
    success: "ExtensionGenerateTextResult",
  },
};

/** Roots the document is built from. Everything they reference follows. */
const ROOTS = [
  ExtensionManifest,
  ExtensionHelloInput,
  ExtensionHelloAck,
  ExtensionRegisterToolsInput,
  ExtensionRegisterToolsResult,
  ExtensionRegisterHttpPrefixInput,
  ExtensionRegisterHttpPrefixResult,
  ExtensionRegisterWebEntryInput,
  ExtensionSetBadgeInput,
  ExtensionBadge,
  ExtensionConnectInput,
  ExtensionStreamEvent,
  ExtensionToolInvocation,
  ExtensionToolsForThreadRequest,
  ExtensionToolsForThreadResult,
  ExtensionHttpRequest,
  ExtensionHttpBody,
  ExtensionToolResult,
  ExtensionHttpResponse,
  ExtensionProjectIconsInput,
  ExtensionProjectIconsResult,
  ExtensionGenerateTextInput,
  ExtensionGenerateTextResult,
  ExtensionError,
] as const;

type JsonSchema = Record<string, unknown>;

const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refName = (ref: string): string => ref.replace("#/$defs/", "");

/**
 * Tagged error classes name their JSON shape `<Tag>Encoded`, which is an
 * Effect implementation detail rather than something an extension author
 * should have to read. The suffix is stripped from both artifacts.
 */
const stripEncodedSuffix = (name: string): string =>
  name.endsWith("Encoded") ? name.slice(0, -"Encoded".length) : name;

const renameRefs = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(renameRefs);
  if (!isSchema(node)) return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) =>
      key === "$ref" && typeof value === "string"
        ? [key, `#/$defs/${stripEncodedSuffix(refName(value))}`]
        : [key, renameRefs(value)],
    ),
  );
};

/**
 * The error schemas a method can fail with, read from its `Rpc.make` in
 * `rpc.ts` rather than restated here. Restating them would be a second list to
 * keep in step with the first, and the whole point of the vendored contract is
 * that an author does not have to guess what a call can return.
 */
const methodErrorSchema = (method: string): Schema.Top => {
  const rpc = WsRpcGroup.requests.get(method);
  if (rpc === undefined) {
    throw new Error(`No RPC named "${method}" in WsRpcGroup; extensions.ts and rpc.ts disagree.`);
  }
  // `Rpc.make({ stream: true })` folds the declared errors into the stream
  // schema and leaves `errorSchema` as Never, so a streaming method read the
  // plain way reports no errors at all.
  const success = rpc.successSchema;
  return RpcSchema.isStreamSchema(success) ? success.error : rpc.errorSchema;
};

const methodErrorNames = (method: string): ReadonlyArray<string> => {
  const root = Schema.toJsonSchemaDocument(methodErrorSchema(method)).schema as {
    readonly anyOf?: ReadonlyArray<JsonSchema>;
    readonly $ref?: string;
  };
  // A union arrives as `anyOf`, a lone error as a bare `$ref`. Anything else
  // means the error channel changed shape; say so rather than quietly
  // publishing a method that cannot fail.
  const members = root.anyOf ?? (root.$ref === undefined ? undefined : [root as JsonSchema]);
  if (members === undefined || members.length === 0) {
    throw new Error(`Could not read the error schemas for "${method}" from rpc.ts.`);
  }
  return members.map((member) => {
    const ref = member["$ref"];
    if (typeof ref !== "string") {
      throw new Error(`Error schema for "${method}" is not a reference to a named error.`);
    }
    return stripEncodedSuffix(refName(ref));
  });
};

/** `METHODS` with each entry's errors resolved from rpc.ts. */
const buildMethods = (): Record<string, MethodEntry> =>
  Object.fromEntries(
    Object.entries(METHODS).map(([method, entry]) => [
      method,
      { ...entry, errors: methodErrorNames(method) },
    ]),
  );

const buildDefinitions = (): Record<string, JsonSchema> => {
  const definitions: Record<string, JsonSchema> = {};
  // Error schemas are roots too: a method that names an error an author cannot
  // decode is only half a contract.
  const roots = [...ROOTS, ...Object.keys(METHODS).map(methodErrorSchema)];
  for (const root of roots) {
    const document = Schema.toJsonSchemaDocument(root);
    for (const [name, schema] of Object.entries(document.definitions)) {
      definitions[stripEncodedSuffix(name)] = renameRefs(schema) as JsonSchema;
    }
  }
  return Object.fromEntries(Object.entries(definitions).sort(([a], [b]) => (a < b ? -1 : 1)));
};

const buildJsonSchema = (definitions: Record<string, JsonSchema>): string => {
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://t3code-extensible.dev/schemas/extensions/protocol-v${EXTENSION_PROTOCOL_VERSION}.json`,
    title: "T3 Code extension protocol",
    description:
      "Generated from packages/contracts/src/extensions.ts. Do not edit. See docs/internals/extensions/protocol.md.",
    "x-protocolVersion": EXTENSION_PROTOCOL_VERSION,
    "x-supportedProtocolVersions": EXTENSION_SUPPORTED_PROTOCOL_VERSIONS,
    "x-methods": buildMethods(),
    $defs: definitions,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
};

// ---------------------------------------------------------------------------
// JSON Schema to TypeScript
// ---------------------------------------------------------------------------

const literal = (value: unknown): string => JSON.stringify(value);

/** Matches the repo formatter, so the committed artifact is a fixed point. */
const PRINT_WIDTH = 100;

/**
 * Only the constructs the protocol actually uses. Anything else throws rather
 * than emitting something plausible but wrong.
 *
 * `prefixWidth` is how much of the line is already spent before this type is
 * printed, which is what decides whether a union fits on one line.
 */
const toTypeScript = (schema: JsonSchema, indent: string, prefixWidth: number): string => {
  if (typeof schema.$ref === "string") return refName(schema.$ref);
  if (Array.isArray(schema.enum)) {
    return renderUnion(schema.enum.map(literal), indent, prefixWidth);
  }
  if (Array.isArray(schema.anyOf)) {
    const members = schema.anyOf.filter(isSchema);
    return renderUnion(
      members.map((member) => toTypeScript(member, `${indent}    `, 0)),
      indent,
      prefixWidth,
    );
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = isSchema(schema.items)
        ? toTypeScript(schema.items, indent, prefixWidth + "ReadonlyArray<".length)
        : "unknown";
      return `ReadonlyArray<${items}>`;
    }
    case "object":
      break;
    default:
      throw new Error(`Unsupported JSON Schema node: ${JSON.stringify(schema)}`);
  }
  const properties = isSchema(schema.properties) ? schema.properties : undefined;
  if (properties === undefined) {
    const additional = schema.additionalProperties;
    const value = isSchema(additional) ? toTypeScript(additional, indent, 0) : "unknown";
    return `Readonly<Record<string, ${value}>>`;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const inner = `${indent}  `;
  const lines = Object.entries(properties).map(([key, value]) => {
    const optional = required.has(key) ? "" : "?";
    const prefix = `${inner}readonly ${key}${optional}: `;
    const rendered = isSchema(value) ? toTypeScript(value, inner, prefix.length) : "unknown";
    return `${prefix}${rendered};`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
};

/**
 * One line while it fits, otherwise the formatter's broken-union shape:
 * leading pipes at `indent + 2`, member bodies at `indent + 4`.
 */
const renderUnion = (
  members: ReadonlyArray<string>,
  indent: string,
  prefixWidth: number,
): string => {
  const inline = members.join(" | ");
  if (!inline.includes("\n") && prefixWidth + inline.length + 1 <= PRINT_WIDTH) return inline;
  return members.map((member) => `\n${indent}  | ${member}`).join("");
};

const buildDeclarations = (definitions: Record<string, JsonSchema>): string => {
  const methodNames = Object.keys(METHODS).map(literal).join("\n  | ");
  const types = Object.entries(definitions).map(([name, schema]) => {
    const description = typeof schema.description === "string" ? schema.description : undefined;
    const comment = description === undefined ? "" : `/** ${description} */\n`;
    const prefix = `export type ${name} = `;
    const rendered = toTypeScript(schema, "", prefix.length);
    const separator = rendered.startsWith("\n") ? "=" : "= ";
    return `${comment}export type ${name} ${separator}${rendered};`;
  });
  // A TypeScript extension has to handle what a call can fail with, and the
  // union differs per method. This is the same map as the schema's
  // `x-methods[].errors`, in the form a `.ts` file can use directly.
  const methodErrors = Object.entries(buildMethods()).map(([method, entry]) => {
    const prefix = `  ${literal(method)}: `;
    const rendered = renderUnion([...(entry.errors ?? [])], "  ", prefix.length);
    // A wrapped union starts on the next line, so the space after the colon
    // would be trailing whitespace.
    return `${rendered.startsWith("\n") ? prefix.trimEnd() : prefix}${rendered};`;
  });

  return [
    "// Generated from packages/contracts/src/extensions.ts. Do not edit.",
    "// Copy this file into your extension; it has no dependencies.",
    `// Protocol version ${EXTENSION_PROTOCOL_VERSION}. Reference: docs/internals/extensions/protocol.md`,
    "",
    `export type ExtensionWsMethod =\n  | ${methodNames};`,
    "",
    `export interface ExtensionMethodErrors {\n${methodErrors.join("\n")}\n}`,
    "",
    ...types.map((type) => `${type}\n`),
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
};

const README = `# Extension protocol, generated

Generated from \`packages/contracts/src/extensions.ts\`. **Do not edit.** Regenerate with
\`pnpm --filter @t3tools/contracts generate:extensions\`; a test fails on any diff.

- \`protocol.schema.json\` — JSON Schema (draft 2020-12) for the manifest and every
  protocol message, plus an \`x-methods\` map from method name to schema. Read this if your
  extension is not written in TypeScript.
- \`protocol.d.ts\` — the same shapes as plain TypeScript declarations, with no
  dependencies. Copy it into a TypeScript extension.

Prose lives in \`docs/internals/extensions/protocol.md\`.
`;

export interface GeneratedArtifact {
  readonly fileName: string;
  readonly contents: string;
}

export const buildExtensionProtocolArtifacts = (): ReadonlyArray<GeneratedArtifact> => {
  const definitions = buildDefinitions();
  return [
    { fileName: "protocol.schema.json", contents: buildJsonSchema(definitions) },
    { fileName: "protocol.d.ts", contents: buildDeclarations(definitions) },
    { fileName: "README.md", contents: README },
  ];
};

export const GENERATED_EXTENSIONS_DIR = "generated/extensions";
