/**
 * The extension's own build. The host never watches source, installs, or
 * compiles: building is the extension's job, and the output folder is the unit
 * the host runs and content-hashes.
 *
 * Emits, per design §6.1:
 *   dist/extension.json  the manifest the host reads before spawning
 *   dist/server.mjs      one self-contained entry — every dependency bundled,
 *                        so the folder needs no node_modules and can sit in a
 *                        read-only app bundle
 *   dist/web/entry.js    an ES module exporting mount/unmount, own React
 *   dist/web/entry.css   scoped styles
 */
import * as esbuild from "esbuild";
import * as NodeChildProcess from "node:child_process";
import { builtinModules } from "node:module";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const here = NodePath.dirname(fileURLToPath(import.meta.url));
const dist = NodePath.join(here, "dist");

await NodeFs.rm(dist, { recursive: true, force: true });
await NodeFs.mkdir(NodePath.join(dist, "web"), { recursive: true });

// The manifest is generated from the same module the server sends in
// `extensions.hello`, so dist/extension.json and the handshake cannot disagree.
const { MANIFEST } = await import("./src/server/manifest.ts");
await NodeFs.writeFile(
  NodePath.join(dist, "extension.json"),
  `${JSON.stringify(MANIFEST, null, 2)}\n`,
);

// Node built-ins stay external in BOTH spellings. The `node:` prefix alone is
// not enough: a CommonJS dependency (ws) requires bare "events" and "http", and
// in ESM output esbuild turns an un-externalised require into a shim that
// throws "Dynamic require of \"events\" is not supported" at startup.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

await esbuild.build({
  entryPoints: [NodePath.join(here, "src/server/main.ts")],
  outfile: NodePath.join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "bundle",
  external: nodeBuiltins,
  // `ws` is CommonJS and requires bare built-ins ("events", "http", ...).
  // esbuild's ESM output emits a shim that defers to a global `require`, which
  // does not exist in a module — so the entry threw on import until this
  // banner supplied one. It only ever resolves built-ins; every non-builtin
  // dependency is still bundled, which the tests assert.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __extensionCreateRequire } from "node:module";',
      "const require = __extensionCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [NodePath.join(here, "src/web/entry.tsx")],
  outfile: NodePath.join(dist, "web/entry.js"),
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  jsx: "automatic",
  // Production React, and `minify` never emits `eval` — but the CSP forbids
  // eval outright, so the check below verifies the output rather than trusting
  // the setting. `sourcemap: "external"` keeps eval-based sourcemaps out.
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  sourcemap: "external",
  logLevel: "info",
});

// The bundle is useless if it cannot run under the desktop CSP, and that
// failure would only show up at mount time in a packaged app. Fail the build
// instead.
const bundled = await NodeFs.readFile(NodePath.join(dist, "web/entry.js"), "utf8");
const evalUse = /(?:^|[^.\w])eval\s*\(|new\s+Function\s*\(/.exec(bundled);
if (evalUse) {
  throw new Error(
    `Web bundle contains ${evalUse[0].trim()}, which the desktop CSP blocks ` +
      `(script-src has no 'unsafe-eval'). See docs/internals/extensions/spikes/electron-runtime.md.`,
  );
}

// A bundle that throws on import is the failure mode this build once shipped: a
// CommonJS dependency's `require` became a shim that threw at startup, and
// nothing noticed until the entry was run. Smoke-test it here.
//
// As a child process, not an `import`: the entry runs on load and exits, so
// importing it into the build would end the build.
const smoke = await new Promise((resolve) => {
  const child = NodeChildProcess.spawn(process.execPath, [NodePath.join(dist, "server.mjs")], {
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("exit", (code) => resolve({ code, stderr }));
});
// Exit 2 with the explanation is the entry correctly refusing to run without a
// host. Anything else means it did not get far enough to check.
if (smoke.code !== 2 || !/started by the host/.test(smoke.stderr)) {
  throw new Error(
    `Built server entry does not start (exit ${String(smoke.code)}):\n${smoke.stderr.trim()}`,
  );
}

console.log(`[build] wrote ${NodePath.relative(here, dist)}/`);
