import { describe, expect, it } from "vite-plus/test";

import {
  extensionRemoteAssetPath,
  loopbackHttpBasePort,
  parseExtensionRemoteAssetPath,
} from "./extensionRemoteAssets.ts";

const assetPath = "/ext-assets/eyJhIjoxfQ.sig/bach/entry.js";

describe("extensionRemoteAssetPath", () => {
  it("round-trips a minted asset path through the client's own origin", () => {
    const path = extensionRemoteAssetPath({ port: 54321, assetPath });
    expect(path).toBe(`/__ext-remote/54321${assetPath}`);
    expect(parseExtensionRemoteAssetPath(path)).toStrictEqual({ port: 54321, assetPath });
  });

  it("is a prefix, so a chunk the bundle imports relatively stays inside it", () => {
    const prefix = extensionRemoteAssetPath({ port: 54321, assetPath: "" });
    const chunk = `${prefix}/ext-assets/eyJhIjoxfQ.sig/bach/chunk-a1.js`;
    expect(parseExtensionRemoteAssetPath(chunk)?.assetPath).toBe(
      "/ext-assets/eyJhIjoxfQ.sig/bach/chunk-a1.js",
    );
  });

  it("parses nothing that is not addressed to the prefix", () => {
    expect(parseExtensionRemoteAssetPath(assetPath)).toBeNull();
    expect(parseExtensionRemoteAssetPath("/__ext-remoteness/54321/ext-assets/a.js")).toBeNull();
    expect(parseExtensionRemoteAssetPath("")).toBeNull();
  });
});

describe("loopbackHttpBasePort", () => {
  it("reads the forwarded port of a loopback base", () => {
    expect(loopbackHttpBasePort("http://127.0.0.1:54321/")).toBe(54321);
    expect(loopbackHttpBasePort("http://localhost:7880")).toBe(7880);
    expect(loopbackHttpBasePort("http://[::1]:7880/")).toBe(7880);
  });

  it("refuses anything that is not this machine, or has no port at all", () => {
    expect(loopbackHttpBasePort("http://192.168.1.20:3773")).toBeNull();
    expect(loopbackHttpBasePort("https://relay.t3.codes/e/abc")).toBeNull();
    expect(loopbackHttpBasePort("http://127.0.0.1/")).toBeNull();
    expect(loopbackHttpBasePort("t3code://app")).toBeNull();
    expect(loopbackHttpBasePort("not a url")).toBeNull();
    expect(loopbackHttpBasePort(null)).toBeNull();
  });
});
