import type { EnvironmentId, ExtensionAssetUrlsResult, ExtensionName } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { rebaseExtensionAssetUrls, resolveExtensionBundleAccess } from "./bundleOrigin";

const LOCAL = "env-local" as EnvironmentId;
const REMOTE = "env-remote" as EnvironmentId;

const browser = {
  rendererHref: "http://localhost:7880/ext/env-local/bach",
  rendererOrigin: "http://localhost:7880",
  isDesktopRenderer: false,
  isSshEnvironment: false,
  environmentId: LOCAL,
  primaryEnvironmentId: LOCAL,
};

const desktop = {
  // The desktop renderer does not load the app over http.
  rendererHref: "t3code://app/ext/env-local/bach",
  rendererOrigin: "t3code://app",
  isDesktopRenderer: true,
  isSshEnvironment: false,
  environmentId: LOCAL,
  primaryEnvironmentId: LOCAL,
};

/** An SSH environment: a different environment, on a forwarded loopback port. */
const overSsh = {
  ...desktop,
  environmentId: REMOTE,
  isSshEnvironment: true,
  httpBaseUrl: "http://127.0.0.1:54321/",
};

describe("resolveExtensionBundleAccess", () => {
  it("loads a bundle served from the page's own origin", () => {
    expect(
      resolveExtensionBundleAccess({ ...browser, httpBaseUrl: "http://localhost:7880" }),
    ).toStrictEqual({ kind: "direct" });
  });

  it("refuses a remote environment in a browser, which has no backend of its own", () => {
    expect(
      resolveExtensionBundleAccess({
        ...browser,
        environmentId: REMOTE,
        isSshEnvironment: true,
        httpBaseUrl: "http://127.0.0.1:54321",
      }),
    ).toStrictEqual({ kind: "unavailable" });
  });

  /*
   * The bug the direct/desktop case exists for. In the packaged desktop the
   * origins never match — `t3code://app` against `http://127.0.0.1:3773` — but
   * the protocol handler proxies every path to the primary backend, so the
   * bundle is reachable page-relative and CSP `'self'` covers it.
   */
  it("loads the primary environment in the desktop renderer, where origins never match", () => {
    expect(
      resolveExtensionBundleAccess({ ...desktop, httpBaseUrl: "http://127.0.0.1:3773" }),
    ).toStrictEqual({ kind: "direct" });
  });

  it("proxies an SSH environment through the desktop's own backend", () => {
    expect(resolveExtensionBundleAccess(overSsh)).toStrictEqual({
      kind: "proxied",
      pathPrefix: "/__ext-remote/54321",
    });
  });

  it("refuses an environment the desktop did not dial over SSH, whatever its base", () => {
    // A second local backend (WSL) is loopback too. It is not a port the SSH
    // bridge opened, so proxying to it would be a relay rather than a lookup.
    expect(resolveExtensionBundleAccess({ ...overSsh, isSshEnvironment: false })).toStrictEqual({
      kind: "unavailable",
    });
  });

  it("refuses an SSH environment whose base is not loopback", () => {
    expect(
      resolveExtensionBundleAccess({ ...overSsh, httpBaseUrl: "http://192.168.1.20:3773" }),
    ).toStrictEqual({ kind: "unavailable" });
  });

  it("refuses a relay environment in the desktop renderer", () => {
    expect(
      resolveExtensionBundleAccess({
        ...desktop,
        environmentId: REMOTE,
        httpBaseUrl: "https://relay.t3.codes/e/abc",
      }),
    ).toStrictEqual({ kind: "unavailable" });
  });

  it("refuses when there is no primary environment to proxy to", () => {
    expect(
      resolveExtensionBundleAccess({
        ...desktop,
        primaryEnvironmentId: null,
        httpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toStrictEqual({ kind: "unavailable" });
  });

  it("refuses in a browser while the connection has no base URL yet", () => {
    expect(resolveExtensionBundleAccess({ ...browser, httpBaseUrl: null })).toStrictEqual({
      kind: "unavailable",
    });
  });

  /*
   * The desktop allowance deliberately does not consult the base URL. The
   * loader imports the path `assetUrls` mints, which is page-relative, so what
   * decides reachability is which environment the protocol handler proxies to —
   * not what that environment's own HTTP base happens to be, or whether the
   * connection has published one yet.
   */
  it("does not need a base URL for the primary environment on the desktop", () => {
    expect(resolveExtensionBundleAccess({ ...desktop, httpBaseUrl: null })).toStrictEqual({
      kind: "direct",
    });
  });

  it("refuses an SSH environment that has no base URL yet", () => {
    expect(resolveExtensionBundleAccess({ ...overSsh, httpBaseUrl: null })).toStrictEqual({
      kind: "unavailable",
    });
  });

  it("refuses a base URL that does not parse", () => {
    expect(resolveExtensionBundleAccess({ ...browser, httpBaseUrl: "http://[" })).toStrictEqual({
      kind: "unavailable",
    });
  });
});

describe("rebaseExtensionAssetUrls", () => {
  const assets: ExtensionAssetUrlsResult = {
    name: "bach" as ExtensionName,
    entry: "/ext-assets/eyJhIjoxfQ.sig/bach/entry.js",
    css: "/ext-assets/eyJhIjoxfQ.sig/bach/entry.css",
    icon: "/ext-assets/eyJhIjoxfQ.sig/bach/icon.svg",
    expiresAt: 1_700_000_000_000,
  };

  it("leaves a direct mount's paths exactly as the environment minted them", () => {
    expect(rebaseExtensionAssetUrls({ kind: "direct" }, assets)).toStrictEqual(assets);
  });

  it("moves only the prefix, so the signed token still authorises the request", () => {
    const rebased = rebaseExtensionAssetUrls(
      { kind: "proxied", pathPrefix: "/__ext-remote/54321" },
      assets,
    );
    expect(rebased.entry).toBe("/__ext-remote/54321/ext-assets/eyJhIjoxfQ.sig/bach/entry.js");
    expect(rebased.css).toBe("/__ext-remote/54321/ext-assets/eyJhIjoxfQ.sig/bach/entry.css");
    expect(rebased.icon).toBe("/__ext-remote/54321/ext-assets/eyJhIjoxfQ.sig/bach/icon.svg");
    expect(rebased.expiresAt).toBe(assets.expiresAt);
  });

  it("carries a fresh Deploy's token through, so the new bundle is a new URL", () => {
    const deployed = { ...assets, entry: "/ext-assets/eyJhIjoyfQ.sig2/bach/entry.js" };
    const access = { kind: "proxied", pathPrefix: "/__ext-remote/54321" } as const;
    expect(rebaseExtensionAssetUrls(access, deployed).entry).not.toBe(
      rebaseExtensionAssetUrls(access, assets).entry,
    );
  });

  it("keeps an absent stylesheet absent rather than inventing one", () => {
    const { css: _css, icon: _icon, ...bare } = assets;
    const rebased = rebaseExtensionAssetUrls(
      { kind: "proxied", pathPrefix: "/__ext-remote/54321" },
      bare,
    );
    expect("css" in rebased).toBe(false);
    expect("icon" in rebased).toBe(false);
  });
});
