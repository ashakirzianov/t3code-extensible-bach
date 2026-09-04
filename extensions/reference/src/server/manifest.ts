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
