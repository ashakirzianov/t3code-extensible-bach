import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clearRemoteEnvironments,
  forgetRemoteEnvironment,
  isRemoteExtensionAssetRoute,
  rememberRemoteEnvironment,
  remoteEnvironmentKey,
  resolveRemoteExtensionAsset,
} from "./RemoteExtensionAssets.ts";

const target = { alias: "box", hostname: "box.local", username: "anton", port: null };
const key = remoteEnvironmentKey(target);
const forwarded = "http://127.0.0.1:54321/";
const assetPath = "/ext-assets/eyJhIjoxfQ.sig/bach/entry.js";

describe("the remote extension asset proxy", () => {
  beforeEach(() => {
    clearRemoteEnvironments();
  });

  it("forwards an asset request to the port this process opened", () => {
    rememberRemoteEnvironment(key, forwarded);
    expect(
      resolveRemoteExtensionAsset({
        method: "GET",
        pathname: `/__ext-remote/54321${assetPath}`,
      }),
    ).toBe(`http://127.0.0.1:54321${assetPath}`);
  });

  it("refuses a port nothing opened, which is what keeps it from being a relay", () => {
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/9999${assetPath}` }),
    ).toBeNull();
  });

  it("refuses a port whose tunnel has been disconnected", () => {
    rememberRemoteEnvironment(key, forwarded);
    forgetRemoteEnvironment(key);
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).toBeNull();
  });

  it("never remembers a base that is not loopback", () => {
    rememberRemoteEnvironment(key, "http://192.168.1.20:54321/");
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).toBeNull();
  });

  it("carries only the asset route, never the environment's own API", () => {
    rememberRemoteEnvironment(key, forwarded);
    for (const pathname of [
      "/__ext-remote/54321/api/environment",
      "/__ext-remote/54321/ext-api/env-1/bach/agents",
      "/__ext-remote/54321/",
      "/__ext-remote/54321",
    ]) {
      expect(resolveRemoteExtensionAsset({ method: "GET", pathname })).toBeNull();
    }
  });

  it("refuses a traversal out of the asset route, encoded or not", () => {
    rememberRemoteEnvironment(key, forwarded);
    for (const pathname of [
      "/__ext-remote/54321/ext-assets/../api/environment",
      "/__ext-remote/54321/ext-assets/%2e%2e/api/environment",
      "/__ext-remote/54321/ext-assets/a\\b",
    ]) {
      expect(resolveRemoteExtensionAsset({ method: "GET", pathname })).toBeNull();
    }
  });

  it("refuses a port that is not a port", () => {
    rememberRemoteEnvironment(key, forwarded);
    for (const pathname of [
      `/__ext-remote/0${assetPath}`,
      `/__ext-remote/99999${assetPath}`,
      `/__ext-remote/54321x${assetPath}`,
      `/__ext-remote/${assetPath}`,
    ]) {
      expect(resolveRemoteExtensionAsset({ method: "GET", pathname })).toBeNull();
    }
  });

  it("answers GET and HEAD and nothing else: an asset is read, never written", () => {
    rememberRemoteEnvironment(key, forwarded);
    const pathname = `/__ext-remote/54321${assetPath}`;
    expect(resolveRemoteExtensionAsset({ method: "HEAD", pathname })).not.toBeNull();
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect(resolveRemoteExtensionAsset({ method, pathname })).toBeNull();
    }
  });

  it("knows which paths are addressed to it, so a refusal 404s instead of falling through", () => {
    expect(isRemoteExtensionAssetRoute(`/__ext-remote/54321${assetPath}`)).toBe(true);
    expect(isRemoteExtensionAssetRoute("/__ext-remote/nonsense")).toBe(true);
    expect(isRemoteExtensionAssetRoute("/ext/env-1/bach")).toBe(false);
    expect(isRemoteExtensionAssetRoute("/ext-assets/sig/bach/entry.js")).toBe(false);
  });

  it("keeps two open environments apart", () => {
    const other = { ...target, alias: "other", hostname: "other.local" };
    rememberRemoteEnvironment(key, forwarded);
    rememberRemoteEnvironment(remoteEnvironmentKey(other), "http://127.0.0.1:54322/");
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54322${assetPath}` }),
    ).toBe(`http://127.0.0.1:54322${assetPath}`);
    forgetRemoteEnvironment(remoteEnvironmentKey(other));
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).not.toBeNull();
  });
});
