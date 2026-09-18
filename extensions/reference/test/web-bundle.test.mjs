/**
 * The web bundle must be a real ES module that the host can `import()` and that
 * survives the desktop Content-Security-Policy.
 *
 * The CSP findings this pins are in
 * docs/internals/extensions/spikes/electron-runtime.md: same-origin `import()`
 * is the only loading strategy that executes, and `script-src` carries no
 * 'unsafe-eval'.
 */
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const bundlePath = NodePath.join(here, "../dist/web/entry.js");
const cssPath = NodePath.join(here, "../dist/web/entry.css");

NodeTest.test(
  "the built web bundle is an importable ES module exporting mount and unmount",
  async () => {
    // Imported as a real module, not string-matched: this fails on a syntax error,
    // a bad import specifier, or output that is secretly CommonJS.
    const module = await import(NodeURL.pathToFileURL(bundlePath).href);
    NodeAssert.equal(typeof module.mount, "function", "bundle must export mount()");
    NodeAssert.equal(typeof module.unmount, "function", "bundle must export unmount()");
    NodeAssert.equal(module.mount.length, 3, "mount(container, hostApi, subPath)");
  },
);

NodeTest.test("the bundle carries its own React rather than expecting the host's", () => {
  const source = NodeFS.readFileSync(bundlePath, "utf8");
  // A bundle that externalised React would leave a bare import behind, and
  // would then fail to resolve in the host's module graph.
  NodeAssert.doesNotMatch(source, /from\s*["']react["']/, "React must be bundled, not imported");
  NodeAssert.doesNotMatch(
    source,
    /from\s*["']react-dom/,
    "react-dom must be bundled, not imported",
  );
});

NodeTest.test("the bundle contains no eval, which the desktop CSP would block", () => {
  const source = NodeFS.readFileSync(bundlePath, "utf8");
  NodeAssert.doesNotMatch(
    source,
    /(?:^|[^.\w])eval\s*\(|new\s+Function\s*\(/,
    "script-src has no 'unsafe-eval'; an eval-emitting bundler mode cannot run at all",
  );
});

NodeTest.test("the bundle loads no code through blob: or data: URLs", () => {
  const source = NodeFS.readFileSync(bundlePath, "utf8");
  // Both are blocked by script-src 'self'; measured in the Electron spike.
  NodeAssert.doesNotMatch(source, /createObjectURL/, "blob: script loading is blocked by the CSP");
  NodeAssert.doesNotMatch(source, /import\(\s*["']data:/, "data: imports are blocked by the CSP");
});

NodeTest.test("the stylesheet is scoped and restyles nothing of the host's", () => {
  const css = NodeFS.readFileSync(cssPath, "utf8");
  // Extension CSS is injected into the host's document. Any selector that is
  // not a t3ref- class can reach the host's own tree.
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/(^|})\s*([^{}@]+)\{/g) ?? [];
  for (const raw of selectors) {
    const selector = raw
      .replace(/^\s*}?\s*/, "")
      .replace(/\{$/, "")
      .trim();
    for (const part of selector.split(",")) {
      NodeAssert.match(
        part.trim(),
        /^\.t3ref-/,
        `selector "${part.trim()}" is not scoped to .t3ref-; it would restyle the host`,
      );
    }
  }
});
