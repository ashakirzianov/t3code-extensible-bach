import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

const { readPreparedConnection } = vi.hoisted(() => ({
  readPreparedConnection: vi.fn<(environmentId: string) => { httpBaseUrl: string } | null>(
    () => null,
  ),
}));

vi.mock("../state/session", () => ({ readPreparedConnection }));

import { createExtensionHostApi } from "./hostApi";

const primary = EnvironmentId.make("env-primary");
const remote = EnvironmentId.make("env-remote");

const hostApi = createExtensionHostApi({
  extensionName: "bach",
  environmentId: primary,
  environments: () => [],
  prefixByEnvironment: () => new Map(),
  navigateToThread: () => {},
});

describe("hostApi.resolveAssetUrl", () => {
  it("resolves a minted favicon path against the environment's base, not the page origin", () => {
    // A packaged desktop page is `t3code://app`; its backend is a loopback port.
    readPreparedConnection.mockImplementation((environmentId) =>
      environmentId === primary ? { httpBaseUrl: "http://127.0.0.1:3773/" } : null,
    );

    expect(hostApi.resolveAssetUrl(primary, "/api/assets/token/favicon.svg")).toBe(
      "http://127.0.0.1:3773/api/assets/token/favicon.svg",
    );
  });

  it("answers null for anything but a root-relative path", () => {
    readPreparedConnection.mockImplementation(() => ({ httpBaseUrl: "http://127.0.0.1:3773/" }));

    expect(hostApi.resolveAssetUrl(primary, "//evil.example/favicon.svg")).toBeNull();
    expect(hostApi.resolveAssetUrl(primary, "https://evil.example/favicon.svg")).toBeNull();
    expect(hostApi.resolveAssetUrl(primary, "api/assets/token/favicon.svg")).toBeNull();
  });

  it("answers null for an environment the client is not connected to", () => {
    readPreparedConnection.mockImplementation(() => null);

    expect(hostApi.resolveAssetUrl(remote, "/api/assets/token/favicon.svg")).toBeNull();
  });
});
