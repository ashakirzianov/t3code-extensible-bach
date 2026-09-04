#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a build script, not server code.
// @effect-diagnostics globalConsole:off - a build script, not server code.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { GENERATED_EXTENSIONS_DIR, buildExtensionProtocolArtifacts } from "./extensionProtocol.ts";

const outputDir = NodePath.join(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
  GENERATED_EXTENSIONS_DIR,
);
NodeFS.mkdirSync(outputDir, { recursive: true });
for (const { fileName, contents } of buildExtensionProtocolArtifacts()) {
  NodeFS.writeFileSync(NodePath.join(outputDir, fileName), contents);
  console.log(`wrote ${NodePath.join(GENERATED_EXTENSIONS_DIR, fileName)}`);
}
