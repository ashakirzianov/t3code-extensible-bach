/**
 * The extension's declared surface, in one place.
 *
 * `MANIFEST` is also what the build writes to `dist/extension.json`, so the
 * file the host reads before spawning and the value sent in `extensions.hello`
 * can never disagree.
 */
import type {
  ExtensionHttpPrefix,
  ExtensionManifest,
  ExtensionResourceDefinition,
  ExtensionToolDefinition,
  ExtensionWebEntry,
} from "../../protocol/protocol.js";

/** Unprefixed and unique across the environment; a collision is rejected by name. */
export const ECHO_TOOL_NAME = "reference_echo";

export const HTTP_PREFIX: ExtensionHttpPrefix = "reference";

export const TOOLS: ReadonlyArray<ExtensionToolDefinition> = [
  {
    name: ECHO_TOOL_NAME,
    description:
      "Echoes its arguments back, together with the caller identity the host attached. " +
      "Demonstrates that an extension never has to trust the agent for who is calling.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Text to echo back." },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
];

/** Unique across the environment, like a tool name; the host's own `t3code://` URIs are taken. */
export const ECHO_RESOURCE_URI = "reference://echoes";

export const RESOURCES: ReadonlyArray<ExtensionResourceDefinition> = [
  {
    uri: ECHO_RESOURCE_URI,
    name: "reference-echoes",
    description:
      "Everything reference_echo has recorded, newest first. Read it to see what an " +
      "extension-owned resource looks like: the host lists it beside its own and forwards " +
      "the read here.",
    mimeType: "application/json",
  },
];

/**
 * Standing guidance for every agent in the environment, appended to the MCP
 * server's own instructions.
 *
 * Kept to a few sentences on purpose. It is billed on every turn of every
 * thread and the whole server-level string is shared with the host's own
 * paragraph and with any other extension, so an extension that writes a page
 * here is an extension that pushes the next one out. What belongs here is what
 * an agent cannot work out from a tool description: what this extension *is*,
 * and when not to reach for it.
 */
export const INSTRUCTIONS = [
  "The `reference` extension is a worked example of the extension protocol, not a working tool.",
  `Its \`${ECHO_TOOL_NAME}\` tool echoes a message back with the caller identity the host resolved,`,
  `and \`${ECHO_RESOURCE_URI}\` lists what it has recorded.`,
  "Neither changes anything in a project, so do not reach for them to get work done.",
].join(" ");

export const WEB_ENTRY: ExtensionWebEntry = {
  entry: "web/entry.js",
  css: "web/entry.css",
  label: "Reference",
};

export const MANIFEST: ExtensionManifest = {
  name: "reference",
  version: "1.0.0",
  protocolVersion: 1,
  server: { entry: "server.mjs" },
  web: WEB_ENTRY,
};
