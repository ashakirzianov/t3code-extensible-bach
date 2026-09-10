import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canLoadExtensionBundle } from "./bundleOrigin";

const LOCAL = "env-local" as EnvironmentId;
const REMOTE = "env-remote" as EnvironmentId;

const browser = {
  rendererHref: "http://localhost:7880/ext/env-local/bach",
  rendererOrigin: "http://localhost:7880",
  isDesktopRenderer: false,
  environmentId: LOCAL,
  primaryEnvironmentId: LOCAL,
};

const desktop = {
  // The desktop renderer does not load the app over http.
  rendererHref: "t3code://app/ext/env-local/bach",
  rendererOrigin: "t3code://app",
  isDesktopRenderer: true,
  environmentId: LOCAL,
  primaryEnvironmentId: LOCAL,
};

describe("canLoadExtensionBundle", () => {
  it("loads a bundle served from the page's own origin", () => {
    expect(canLoadExtensionBundle({ ...browser, httpBaseUrl: "http://localhost:7880" })).toBe(true);
  });

  it("refuses a remote environment in a browser", () => {
    expect(
      canLoadExtensionBundle({
        ...browser,
        environmentId: REMOTE,
        httpBaseUrl: "http://192.168.1.20:3773",
      }),
    ).toBe(false);
  });

  /*
   * The bug this function exists for. In the packaged desktop the origins never
   * match — `t3code://app` against `http://127.0.0.1:3773` — but the protocol
   * handler proxies every path to the primary backend, so the bundle is
   * reachable page-relative and CSP `'self'` covers it. Comparing origins alone
   * hid the local environment's extensions behind the remote-server message.
   */
  it("loads the primary environment in the desktop renderer, where origins never match", () => {
    expect(canLoadExtensionBundle({ ...desktop, httpBaseUrl: "http://127.0.0.1:3773" })).toBe(true);
  });

  it("still refuses a genuinely remote environment in the desktop renderer", () => {
    expect(
      canLoadExtensionBundle({
        ...desktop,
        environmentId: REMOTE,
        httpBaseUrl: "http://192.168.1.20:3773",
      }),
    ).toBe(false);
  });

  it("refuses when there is no primary environment to proxy to", () => {
    expect(
      canLoadExtensionBundle({
        ...desktop,
        primaryEnvironmentId: null,
        httpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe(false);
  });

  it("refuses in a browser while the connection has no base URL yet", () => {
    expect(canLoadExtensionBundle({ ...browser, httpBaseUrl: null })).toBe(false);
  });

  /*
   * The desktop allowance deliberately does not consult the base URL. The
   * loader imports the path `assetUrls` mints, which is page-relative, so what
   * decides reachability is which environment the protocol handler proxies to —
   * not what that environment's own HTTP base happens to be, or whether the
   * connection has published one yet.
   */
  it("does not need a base URL for the primary environment on the desktop", () => {
    expect(canLoadExtensionBundle({ ...desktop, httpBaseUrl: null })).toBe(true);
  });

  it("refuses a base URL that does not parse", () => {
    expect(canLoadExtensionBundle({ ...browser, httpBaseUrl: "http://[" })).toBe(false);
  });
});
