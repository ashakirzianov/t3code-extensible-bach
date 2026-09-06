// @effect-diagnostics nodeBuiltinImport:off - compares committed files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const GENERATED_DIR = "packages/contracts/generated/extensions";
const VENDORED_DIR = "extensions/reference/protocol";
const VENDORED_FILES = ["protocol.schema.json", "protocol.d.ts"] as const;

/**
 * The reference extension vendors the protocol the way an author does, which
 * means its copy is a snapshot and can silently fall behind. Its own tests
 * would then keep passing against a contract the host no longer speaks, and
 * the worked example would teach the wrong shapes. A protocol change has to
 * force a re-vendor here rather than at the next person to notice.
 */
describe("vendored protocol copy", () => {
  for (const fileName of VENDORED_FILES) {
    it(`${fileName} matches the generated artifact`, () => {
      const generated = NodeFS.readFileSync(
        NodePath.join(repoRoot, GENERATED_DIR, fileName),
        "utf8",
      );
      const vendored = NodeFS.readFileSync(NodePath.join(repoRoot, VENDORED_DIR, fileName), "utf8");
      if (generated !== vendored) {
        throw new Error(
          `${VENDORED_DIR}/${fileName} is behind ${GENERATED_DIR}/${fileName}. ` +
            "Re-vendor with `pnpm sync:protocol` in extensions/reference.",
        );
      }
      expect(vendored).toBe(generated);
    });
  }
});
