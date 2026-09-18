/**
 * The built manifest must validate against the host's published schema.
 *
 * This is the check that would have caught a manifest drifting from the
 * contract after a protocol bump: the schema is vendored from the host, so
 * re-copying it and re-running this test is the whole upgrade procedure.
 */
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
// The generated schema is JSON Schema draft 2020-12; the default Ajv export
// only speaks draft-07 and rejects it with "no schema with key or ref".
import Ajv from "ajv/dist/2020.js";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const root = NodePath.join(here, "..");
const readJson = (relative) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(root, relative), "utf8"));

const schema = readJson("protocol/protocol.schema.json");
const manifest = readJson("dist/extension.json");

/** Compiles one `$defs` entry of the vendored schema as a standalone validator. */
const validatorFor = (definition) => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile({ ...schema, $ref: `#/$defs/${definition}` });
};

NodeTest.test("the built manifest validates against the host's ExtensionManifest schema", () => {
  const validate = validatorFor("ExtensionManifest");
  NodeAssert.ok(
    validate(manifest),
    `dist/extension.json is not a valid ExtensionManifest: ${JSON.stringify(validate.errors, null, 2)}`,
  );
});

NodeTest.test("the manifest declares the protocol version the vendored schema describes", () => {
  // A vendored schema that has moved on from the manifest is exactly the drift
  // this extension is meant to demonstrate catching.
  NodeAssert.equal(manifest.protocolVersion, schema["x-protocolVersion"]);
});

NodeTest.test("every path the manifest declares exists in the built folder", () => {
  // The host runs the built folder as-is; a manifest pointing at a file the
  // build did not emit fails at spawn or at mount, far from the cause.
  const declared = [
    manifest.server.entry,
    manifest.web?.entry,
    manifest.web?.css,
    manifest.web?.icon,
  ].filter((value) => typeof value === "string");

  NodeAssert.ok(declared.length >= 3, "expected server entry plus web entry and css");
  for (const relative of declared) {
    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(root, "dist", relative)),
      `manifest declares "${relative}" but dist/${relative} does not exist`,
    );
  }
});

NodeTest.test("the registered tool definition validates against the host's schema", async () => {
  const validate = validatorFor("ExtensionToolDefinition");
  const { TOOLS } = await import("../src/server/manifest.ts");
  for (const tool of TOOLS) {
    NodeAssert.ok(
      validate(tool),
      `tool "${tool.name}" is not a valid ExtensionToolDefinition: ${JSON.stringify(validate.errors)}`,
    );
  }
});
