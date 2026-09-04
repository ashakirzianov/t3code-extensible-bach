// @effect-diagnostics nodeBuiltinImport:off - reads the committed artifacts off disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  EXTENSION_GUIDE_DIR,
  GENERATE_COMMAND,
  buildExtensionGuideArtifacts,
} from "./extensionGuide.ts";

const guideDir = NodePath.join(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
  EXTENSION_GUIDE_DIR,
);

/**
 * The guides are what an agent with no checkout reads, so a protocol change or
 * an edit to the reference extension that skips the generator has to fail here
 * rather than ship documentation that describes something else.
 */
describe("generated extension guide", () => {
  for (const { fileName, contents } of buildExtensionGuideArtifacts()) {
    it(`${fileName} matches the committed copy`, () => {
      const committed = NodeFS.readFileSync(NodePath.join(guideDir, fileName), "utf8");
      if (contents !== committed) {
        throw new Error(`${fileName} is stale. Regenerate with \`${GENERATE_COMMAND}\`.`);
      }
      expect(contents).toBe(committed);
    });
  }

  it("keeps both guides readable away from the repository", () => {
    for (const { fileName, contents } of buildExtensionGuideArtifacts()) {
      // A link with a bare relative target only resolves next to the source
      // file; served on its own it is a dead end.
      const relativeLinks = contents.match(/\]\((?!https?:\/\/|#|\/)[^)]+\)/gu) ?? [];
      const unrooted = relativeLinks.filter((link) => !link.startsWith("](docs/"));
      expect({ fileName, unrooted }).toEqual({ fileName, unrooted: [] });
    }
  });
});
