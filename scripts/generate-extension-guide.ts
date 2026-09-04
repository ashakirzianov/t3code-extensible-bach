#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a build script, not server code.
// @effect-diagnostics globalConsole:off - a build script, not server code.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { EXTENSION_GUIDE_DIR, buildExtensionGuideArtifacts } from "./extensionGuide.ts";

const outputDir = NodePath.join(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
  EXTENSION_GUIDE_DIR,
);
NodeFS.mkdirSync(outputDir, { recursive: true });
for (const { fileName, contents } of buildExtensionGuideArtifacts()) {
  NodeFS.writeFileSync(NodePath.join(outputDir, fileName), contents);
  console.log(`wrote ${NodePath.join(EXTENSION_GUIDE_DIR, fileName)}`);
}
