import { assert, describe, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  assetContentType,
  decodeResponseBody,
  encodeRequestBody,
  exceedsBodyCap,
  isTextualContentType,
  normalizeRequestHeaders,
  normalizeResponseHeaders,
  parseExtApiPath,
  parseExtAssetPath,
  resolveWebAssetPath,
  toExtensionHttpMethod,
  webAssetDirectory,
} from "./ExtensionHttp.ts";
import { EXTENSION_HTTP_BODY_MAX_CHARS, type ExtensionWebEntry } from "@t3tools/contracts";

const web: ExtensionWebEntry = { entry: "web/entry.js", css: "web/entry.css", label: "Reference" };

// POSIX helpers directly, so the traversal cases assert one platform's
// semantics rather than whichever the test host happens to run.
const pathHelpers = {
  join: NodePath.posix.join,
  normalize: NodePath.posix.normalize,
  isAbsolute: NodePath.posix.isAbsolute,
};

describe("parseExtApiPath", () => {
  it("splits the environment, the prefix, and the path below it", () => {
    // The path below the prefix is what the extension routes on, so a route
    // matches "/status" no matter where the host mounted the prefix.
    assert.deepEqual(parseExtApiPath("/ext-api/env-1/reference/status"), {
      environmentId: "env-1",
      prefix: "reference",
      path: "/status",
    });
  });

  it("gives the prefix root a '/' path rather than an empty one", () => {
    assert.deepEqual(parseExtApiPath("/ext-api/env-1/reference"), {
      environmentId: "env-1",
      prefix: "reference",
      path: "/",
    });
  });

  it("keeps nested paths intact", () => {
    assert.equal(parseExtApiPath("/ext-api/env-1/reference/a/b/c")?.path, "/a/b/c");
  });

  it("rejects paths that name no prefix", () => {
    assert.isNull(parseExtApiPath("/ext-api/env-1"));
    assert.isNull(parseExtApiPath("/ext-api/"));
    assert.isNull(parseExtApiPath("/api/env-1/reference/status"));
  });
});

describe("request translation", () => {
  it("strips hop-by-hop and credential headers and lowercases the rest", () => {
    // The extension has already been authorised by the host; forwarding the
    // caller's credential would hand it a token it was never granted.
    const headers = normalizeRequestHeaders({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      DPoP: "proof",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      "Content-Length": "12",
      Host: "example.test",
      "X-Custom": "kept",
    });
    assert.deepEqual(headers, { "content-type": "application/json", "x-custom": "kept" });
  });

  it("joins repeated headers rather than dropping one", () => {
    assert.equal(normalizeRequestHeaders({ "x-multi": ["a", "b"] })["x-multi"], "a, b");
  });

  it("drops response headers the host owns", () => {
    const headers = normalizeResponseHeaders({
      "Content-Type": "text/plain",
      "Set-Cookie": "a=b",
      "Transfer-Encoding": "chunked",
      "Content-Length": "3",
    });
    assert.deepEqual(headers, { "content-type": "text/plain" });
  });

  it("encodes textual bodies as utf8 and everything else as base64", () => {
    assert.isTrue(isTextualContentType("application/json; charset=utf-8"));
    assert.isTrue(isTextualContentType("text/html"));
    assert.isTrue(isTextualContentType("application/vnd.api+json"));
    assert.isFalse(isTextualContentType("image/png"));
    assert.isFalse(isTextualContentType(undefined));

    const text = encodeRequestBody(new TextEncoder().encode("hello"), "text/plain");
    assert.deepEqual(text, { encoding: "utf8", data: "hello" });

    const binary = encodeRequestBody(new Uint8Array([0, 1, 2, 253]), "image/png");
    assert.equal(binary.encoding, "base64");
    // Round trip, because a body that survives the wire is the whole point.
    assert.deepEqual(Array.from(decodeResponseBody(binary)), [0, 1, 2, 253]);
  });

  it("caps on the encoded string, which is what actually crosses the wire", () => {
    // base64 is a third larger than its bytes, so a byte-length cap would let
    // an over-cap payload through.
    assert.isFalse(exceedsBodyCap({ encoding: "utf8", data: "x".repeat(1024) }));
    assert.isTrue(
      exceedsBodyCap({ encoding: "base64", data: "x".repeat(EXTENSION_HTTP_BODY_MAX_CHARS + 1) }),
    );
  });

  it("accepts only the methods the contract names", () => {
    assert.equal(toExtensionHttpMethod("get"), "GET");
    assert.equal(toExtensionHttpMethod("DELETE"), "DELETE");
    assert.isNull(toExtensionHttpMethod("TRACE"));
  });
});

describe("resolveWebAssetPath", () => {
  const resolve = (requestedPath: string) =>
    resolveWebAssetPath({ extensionPath: "/ext/reference", web, requestedPath, ...pathHelpers });

  it("serves the declared entry and its siblings", () => {
    // A code-split bundle imports sibling chunks by relative path; refusing
    // them would mean the web entry only works as a single file.
    assert.equal(resolve("entry.js"), "/ext/reference/web/entry.js");
    assert.equal(resolve("chunk-abc.js"), "/ext/reference/web/chunk-abc.js");
    assert.equal(resolve("nested/deep.js"), "/ext/reference/web/nested/deep.js");
  });

  it("refuses to escape the web directory", () => {
    for (const attempt of [
      "../server.mjs",
      "../../etc/passwd",
      "nested/../../server.mjs",
      "./../../secret",
      "/etc/passwd",
      "",
    ]) {
      assert.isNull(resolve(attempt), `expected "${attempt}" to be rejected`);
    }
  });

  it("refuses a NUL byte, which can truncate a path in a native call", () => {
    assert.isNull(resolve("entry.js\0.txt"));
  });

  it("locates the web directory from the declared entry", () => {
    assert.equal(webAssetDirectory(web), "web");
    assert.equal(webAssetDirectory({ ...web, entry: "entry.js" }), "");
  });
});

describe("assetContentType", () => {
  it("serves modules as JavaScript, which the browser requires to execute them", () => {
    assert.match(assetContentType("/x/entry.js"), /^text\/javascript/);
    assert.match(assetContentType("/x/entry.mjs"), /^text\/javascript/);
    assert.match(assetContentType("/x/entry.css"), /^text\/css/);
    assert.equal(assetContentType("/x/icon.svg"), "image/svg+xml");
    assert.equal(assetContentType("/x/thing.bin"), "application/octet-stream");
  });
});

describe("parseExtAssetPath", () => {
  it("splits the token, the name, and the asset path", () => {
    assert.deepEqual(parseExtAssetPath("/ext-assets/tok.sig/reference/entry.js"), {
      token: "tok.sig",
      name: "reference",
      path: "entry.js",
    });
  });

  it("keeps nested asset paths", () => {
    assert.equal(parseExtAssetPath("/ext-assets/t/reference/a/b.js")?.path, "a/b.js");
  });

  it("rejects paths missing a token, a name, or a file", () => {
    assert.isNull(parseExtAssetPath("/ext-assets/tok/reference"));
    assert.isNull(parseExtAssetPath("/ext-assets/tok"));
    assert.isNull(parseExtAssetPath("/assets/tok/reference/entry.js"));
  });
});
