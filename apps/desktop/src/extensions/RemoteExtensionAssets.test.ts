import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clearRemoteEnvironments,
  forgetRemoteEnvironment,
  isRemoteExtensionAssetRoute,
  rememberRemoteEnvironment,
  remoteExtensionAssetRequestInit,
  resolveRemoteExtensionAsset,
} from "./RemoteExtensionAssets.ts";

const forwarded = "http://127.0.0.1:54321/";
const tunnelA = { tunnelId: "tunnel-1", httpBaseUrl: forwarded };
const tunnelB = { tunnelId: "tunnel-2", httpBaseUrl: forwarded };
const assetPath = "/ext-assets/eyJhIjoxfQ.sig/bach/entry.js";

describe("the remote extension asset proxy", () => {
  beforeEach(() => {
    clearRemoteEnvironments();
  });

  it("forwards an asset request to the port this process opened", () => {
    rememberRemoteEnvironment(tunnelA);
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

  it("refuses a port whose tunnel has gone, however it went", () => {
    // The tunnel manager raises `closed` for an explicit disconnect, for a
    // teardown that then failed part-way, and for an ssh process that died on
    // its own. All three arrive here as the same call, and a port some other
    // local service may bind next must not be proxyable.
    rememberRemoteEnvironment(tunnelA);
    forgetRemoteEnvironment(tunnelA);
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).toBeNull();
  });

  it("takes a repeated close, which is what a death and a teardown both raising looks like", () => {
    rememberRemoteEnvironment(tunnelA);
    forgetRemoteEnvironment(tunnelA);
    forgetRemoteEnvironment(tunnelA);
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).toBeNull();
  });

  it("forgets the port even when the same port is later opened again", () => {
    rememberRemoteEnvironment(tunnelA);
    forgetRemoteEnvironment(tunnelA);
    rememberRemoteEnvironment(tunnelA);
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).not.toBeNull();
  });

  /*
   * The two events are not ordered with each other. A tunnel that died can be
   * reported closed after the next one was handed the same ephemeral port, and
   * a registry keyed on the port alone would take a live environment's
   * interface away at the worst possible moment.
   */
  it("does not let a late close of a dead tunnel forget the live one on its port", () => {
    const live = resolveRemoteExtensionAsset({
      method: "GET",
      pathname: `/__ext-remote/54321${assetPath}`,
    });
    expect(live).toBeNull();

    rememberRemoteEnvironment(tunnelA);
    // A dies; the port is reserved again and handed to B before A's close is
    // delivered.
    rememberRemoteEnvironment(tunnelB);
    forgetRemoteEnvironment(tunnelA);

    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).toBe(`http://127.0.0.1:54321${assetPath}`);

    // B's own close still ends it.
    forgetRemoteEnvironment(tunnelB);
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).toBeNull();
  });

  it("forwards with no credential and no redirect of the far side's choosing", () => {
    const init = remoteExtensionAssetRequestInit("GET");
    // A followed 30x would end "a port, never a URL" at the far side's first
    // redirect, and whatever answered would come back as script under this
    // app's own origin.
    expect(init.redirect).toBe("error");
    // The signed token in the path is the whole credential; nothing of the
    // app's session may ride along, and a remote 401 must not become the app's
    // own login event.
    expect(init.credentials).toBe("omit");
    expect(init.headers).toBeUndefined();
    expect(remoteExtensionAssetRequestInit("HEAD").method).toBe("HEAD");
  });

  it("never remembers a base that is not loopback", () => {
    rememberRemoteEnvironment({
      tunnelId: "tunnel-lan",
      httpBaseUrl: "http://192.168.1.20:54321/",
    });
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).toBeNull();
  });

  it("carries only the asset route, never the environment's own API", () => {
    rememberRemoteEnvironment(tunnelA);
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
    rememberRemoteEnvironment(tunnelA);
    for (const pathname of [
      "/__ext-remote/54321/ext-assets/../api/environment",
      "/__ext-remote/54321/ext-assets/%2e%2e/api/environment",
      "/__ext-remote/54321/ext-assets/a\\b",
    ]) {
      expect(resolveRemoteExtensionAsset({ method: "GET", pathname })).toBeNull();
    }
  });

  it("refuses a port that is not a port", () => {
    rememberRemoteEnvironment(tunnelA);
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
    rememberRemoteEnvironment(tunnelA);
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
    rememberRemoteEnvironment(tunnelA);
    rememberRemoteEnvironment({ tunnelId: "tunnel-3", httpBaseUrl: "http://127.0.0.1:54322/" });
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54322${assetPath}` }),
    ).toBe(`http://127.0.0.1:54322${assetPath}`);
    forgetRemoteEnvironment({ tunnelId: "tunnel-3", httpBaseUrl: "http://127.0.0.1:54322/" });
    expect(
      resolveRemoteExtensionAsset({ method: "GET", pathname: `/__ext-remote/54321${assetPath}` }),
    ).not.toBeNull();
  });
});
