import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clearRemoteEnvironments,
  forgetPrimaryBackend,
  forgetRemoteEnvironment,
  isPrimaryExtensionAssetRoute,
  isRemoteExtensionAssetRoute,
  rememberPrimaryBackend,
  rememberRemoteEnvironment,
  extensionAssetProxyRequestInit,
  resolvePrimaryExtensionAsset,
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
    const init = extensionAssetProxyRequestInit("GET");
    // A followed 30x would end "a port, never a URL" at the far side's first
    // redirect, and whatever answered would come back as script under this
    // app's own origin.
    expect(init.redirect).toBe("error");
    // The signed token in the path is the whole credential; nothing of the
    // app's session may ride along, and a remote 401 must not become the app's
    // own login event.
    expect(init.credentials).toBe("omit");
    expect(init.headers).toBeUndefined();
    expect(extensionAssetProxyRequestInit("HEAD").method).toBe("HEAD");
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

const primaryBase = "http://127.0.0.1:3773/";

describe("the primary environment's asset bridge", () => {
  beforeEach(() => {
    forgetPrimaryBackend();
  });

  it("forwards the renderer's own asset path to the backend this process started", () => {
    rememberPrimaryBackend(primaryBase);
    expect(resolvePrimaryExtensionAsset({ method: "GET", pathname: assetPath })).toBe(
      `http://127.0.0.1:3773${assetPath}`,
    );
  });

  /*
   * The protocol handler is registered before there is a backend to name, and
   * upstream now boots a window with no local backend at all. Both look the
   * same from here, and both have to be a 404 rather than a guess.
   */
  it("has nowhere to send a request until a backend is named, and 404s meanwhile", () => {
    expect(resolvePrimaryExtensionAsset({ method: "GET", pathname: assetPath })).toBeNull();
  });

  /*
   * The cell tracks the backend's life, not the process's. A backend that has
   * stopped leaves its loopback port free for an unrelated local process to
   * bind, and answering for it afterwards would put that process's bytes under
   * the renderer's own origin, where `script-src 'self'` runs them.
   */
  it("stops forwarding the moment the backend stops, and forwards again when it is back", () => {
    rememberPrimaryBackend(primaryBase);
    forgetPrimaryBackend();
    expect(resolvePrimaryExtensionAsset({ method: "GET", pathname: assetPath })).toBeNull();

    rememberPrimaryBackend(primaryBase);
    expect(resolvePrimaryExtensionAsset({ method: "GET", pathname: assetPath })).not.toBeNull();
  });

  it("refuses a base that is not loopback, exactly as the remote path does", () => {
    // Server exposure keeps `httpBaseUrl` on 127.0.0.1 even in
    // network-accessible mode, where only `bindHost` opens up. That is another
    // module's invariant, so it is checked here rather than inherited.
    for (const base of [
      "http://192.168.1.20:3773/",
      "https://example.com/",
      "http://127.0.0.1/",
      "file:///tmp/",
      "not a url",
    ]) {
      rememberPrimaryBackend(base);
      expect(resolvePrimaryExtensionAsset({ method: "GET", pathname: assetPath })).toBeNull();
    }
  });

  it("refuses a non-loopback base handed straight to the resolver", () => {
    // The bar is re-checked rather than assumed held at the door above.
    expect(
      resolvePrimaryExtensionAsset({
        method: "GET",
        pathname: assetPath,
        lookup: () => "http://192.168.1.20:3773/",
      }),
    ).toBeNull();
  });

  it("takes the other loopback spellings", () => {
    for (const base of ["http://localhost:3773/", "http://[::1]:3773/"]) {
      rememberPrimaryBackend(base);
      expect(resolvePrimaryExtensionAsset({ method: "GET", pathname: assetPath })).not.toBeNull();
    }
  });

  it("carries only the asset route, never the backend's own API", () => {
    rememberPrimaryBackend(primaryBase);
    for (const pathname of [
      "/api/environment",
      "/ext-api/env-1/bach/agents",
      "/ext-assets",
      "/",
      "/index.html",
    ]) {
      expect(resolvePrimaryExtensionAsset({ method: "GET", pathname })).toBeNull();
    }
  });

  it("refuses a traversal out of the asset route, encoded or not", () => {
    rememberPrimaryBackend(primaryBase);
    for (const pathname of [
      "/ext-assets/../api/environment",
      "/ext-assets/%2e%2e/api/environment",
      "/ext-assets/a\\b",
    ]) {
      expect(resolvePrimaryExtensionAsset({ method: "GET", pathname })).toBeNull();
    }
  });

  it("answers GET and HEAD and nothing else: an asset is read, never written", () => {
    rememberPrimaryBackend(primaryBase);
    expect(resolvePrimaryExtensionAsset({ method: "HEAD", pathname: assetPath })).not.toBeNull();
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect(resolvePrimaryExtensionAsset({ method, pathname: assetPath })).toBeNull();
    }
  });

  it("knows which paths are addressed to it, so a refusal 404s instead of falling through", () => {
    expect(isPrimaryExtensionAssetRoute(assetPath)).toBe(true);
    expect(isPrimaryExtensionAssetRoute("/ext-assets/nonsense")).toBe(true);
    expect(isPrimaryExtensionAssetRoute("/ext-assets")).toBe(false);
    expect(isPrimaryExtensionAssetRoute("/ext/env-1/bach")).toBe(false);
    expect(isPrimaryExtensionAssetRoute(`/__ext-remote/54321${assetPath}`)).toBe(false);
  });
});
