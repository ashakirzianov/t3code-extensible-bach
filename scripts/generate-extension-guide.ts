#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a build script, not server code.
// @effect-diagnostics globalConsole:off - a build script, not server code.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { buildExtensionGuideArtifacts } from "./extensionGuide.ts";

const repoRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
for (const { directory, fileName, contents } of buildExtensionGuideArtifacts()) {
  const outputDir = NodePath.join(repoRoot, directory);
  NodeFS.mkdirSync(outputDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(outputDir, fileName), contents);
  console.log(`wrote ${NodePath.join(directory, fileName)}`);
}
