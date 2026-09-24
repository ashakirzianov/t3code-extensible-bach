/**
 * The built server entry must be runnable and must fail clearly without a host.
 *
 * Until the host's lifecycle lands there is no end-to-end run, so what is
 * testable is the boundary: the entry starts on an ordinary Node, and a human
 * who runs it directly gets an explanation instead of a stack trace.
 */
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const serverEntry = NodePath.join(here, "../dist/server.mjs");

/** Runs the built entry with a controlled environment and collects its output. */
const runEntry = (env) =>
  new Promise((resolve) => {
    const child = NodeChildProcess.spawn(process.execPath, [serverEntry], {
      // Deliberately not inheriting: the point is to control exactly which of
      // the four spawn variables the entry can see.
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

NodeTest.test("the built server entry is self-contained: no node_modules beside it", () => {
  // Design §6.1: the folder must be portable, hashable, and able to sit in a
  // read-only app bundle, which rules out resolving dependencies at runtime.
  NodeAssert.ok(NodeFS.existsSync(serverEntry));
  NodeAssert.ok(
    !NodeFS.existsSync(NodePath.join(here, "../dist/node_modules")),
    "dist must not contain node_modules",
  );
  const source = NodeFS.readFileSync(serverEntry, "utf8");
  // Only Node built-ins may remain as imports; a bare specifier would mean a
  // dependency escaped the bundle.
  const imports = [...source.matchAll(/(?:^|\s)(?:import|export)[^;]*?from\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/"));
  for (const specifier of imports) {
    NodeAssert.match(specifier, /^node:/, `dependency "${specifier}" was not bundled`);
  }
});

NodeTest.test("without the spawn environment it explains itself and exits 2", async () => {
  const { code, stderr } = await runEntry({});
  NodeAssert.equal(code, 2, "a missing spawn contract is not a crash");
  NodeAssert.match(stderr, /started by the host, not run directly/);
  // Naming every missing variable is the whole point: one at a time is a bad
  // experience for someone wiring this up by hand.
  for (const name of ["T3_EXT_NAME", "T3_EXT_TOKEN", "T3_EXT_WS_URL", "T3_EXT_DATA_DIR"]) {
    NodeAssert.match(stderr, new RegExp(name));
  }
  NodeAssert.doesNotMatch(stderr, /at .*\n\s+at /, "should not print a stack trace");
});

NodeTest.test("it reports exactly which variable is missing when only one is absent", async () => {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3ref-"));
  const { code, stderr } = await runEntry({
    T3_EXT_NAME: "reference",
    T3_EXT_TOKEN: "test-token",
    T3_EXT_DATA_DIR: dataDir,
    // T3_EXT_WS_URL deliberately absent.
  });
  NodeAssert.equal(code, 2);
  NodeAssert.match(stderr, /T3_EXT_WS_URL/);
  NodeAssert.doesNotMatch(stderr, /T3_EXT_TOKEN/, "should not report variables that were supplied");
});

NodeTest.test(
  "with a host that is not listening it fails without corrupting its data directory",
  async () => {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3ref-"));
    const { code } = await runEntry({
      T3_EXT_NAME: "reference",
      T3_EXT_TOKEN: "test-token",
      // Port 1 is reserved and never listening, so this is a connect failure.
      // The host's ordinary client socket: an extension is a plain client,
      // and the `extension` scope is what unlocks the extensions.* methods on it.
      T3_EXT_WS_URL: "ws://127.0.0.1:1/ws",
      T3_EXT_DATA_DIR: dataDir,
      T3_EXT_PROTOCOL_VERSION: "1",
    });
    NodeAssert.equal(code, 1, "an unreachable host is a real fault, unlike a missing contract");
    // The store is opened before the socket, so this also proves node:sqlite
    // works in the bundled entry on a plain Node.
    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(dataDir, "reference-extension.sqlite")),
      "the database should have been created in the host-assigned data directory",
    );
  },
);

NodeTest.test("a resource read is answered from the store without a caller identity", async () => {
  // The read path is pure, so it is checkable without a host: a resource
  // carries no `ExtensionToolCaller`, which is exactly what separates it from
  // a tool invocation.
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3ref-"));
  const { EchoStore } = await import("../src/server/store.ts");
  const { readEchoResource } = await import("../src/server/resources.ts");
  const { ECHO_RESOURCE_URI } = await import("../src/server/manifest.ts");

  const store = new EchoStore(dataDir);
  try {
    store.record("thread-1", "hello");
    const result = readEchoResource(store, { requestId: "read-1", uri: ECHO_RESOURCE_URI });
    NodeAssert.equal(result.requestId, "read-1");
    NodeAssert.equal(result.contents.length, 1);
    NodeAssert.equal(result.contents[0].uri, ECHO_RESOURCE_URI);
    const parsed = JSON.parse(result.contents[0].text);
    NodeAssert.equal(parsed.echoCount, 1);
    NodeAssert.equal(parsed.lastEcho.message, "hello");

    // The answer quotes the URI it was asked for, which is what lets the same
    // handler serve more than one without a table of its own.
    const other = readEchoResource(store, { requestId: "read-2", uri: "reference://other" });
    NodeAssert.equal(other.contents[0].uri, "reference://other");
  } finally {
    store.close();
  }
});
