// @effect-diagnostics nodeBuiltinImport:off - reads the committed artifacts off disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  GENERATED_EXTENSIONS_DIR,
  buildExtensionProtocolArtifacts,
} from "../scripts/extensionProtocol.ts";

const generatedDir = NodePath.join(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
  GENERATED_EXTENSIONS_DIR,
);

/**
 * The committed files under `generated/extensions/` are what extension authors
 * vendor, so a protocol change that skips the generator has to fail here
 * rather than ship a stale contract.
 */
describe("generated extension protocol artifacts", () => {
  for (const { fileName, contents } of buildExtensionProtocolArtifacts()) {
    it(`${fileName} matches the committed copy`, () => {
      const committed = NodeFS.readFileSync(NodePath.join(generatedDir, fileName), "utf8");
      expect(contents).toBe(committed);
    });
  }
});
