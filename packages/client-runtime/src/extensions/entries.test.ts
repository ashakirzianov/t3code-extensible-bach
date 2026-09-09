import type { EnvironmentId, ExtensionStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  extensionBadgeTotal,
  extensionNavEntries,
  extensionUnavailableMessage,
  findExtensionNavEntry,
} from "./entries.ts";

const environmentId = (value: string) => value as EnvironmentId;

const status = (overrides: Partial<ExtensionStatus> & { name: string }): ExtensionStatus =>
  ({
    path: `/extensions/${overrides.name}`,
    source: "settings",
    enabled: true,
    state: "running",
    changed: false,
    tools: [],
    restartCount: 0,
    ...overrides,
  }) as ExtensionStatus;

const web = (label: string) => ({ entry: "web/entry.js", label });

describe("extension nav entries", () => {
  it("keeps only the extensions that have a web entry to mount", () => {
    const entries = extensionNavEntries([
      {
        environmentId: environmentId("env-1"),
        environmentLabel: "Laptop",
        extensions: [
          status({ name: "bach", web: web("Bach") }),
          status({ name: "headless" }),
          status({ name: "notes", web: web("Notes") }),
        ],
      },
    ]);

    expect(entries.map((entry) => entry.name)).toEqual(["bach", "notes"]);
    expect(entries[0]?.label).toBe("Bach");
  });

  it("labels rows by environment only when more than one is connected", () => {
    const single = extensionNavEntries([
      {
        environmentId: environmentId("env-1"),
        environmentLabel: "Laptop",
        extensions: [status({ name: "bach", web: web("Bach") })],
      },
    ]);
    expect(single[0]?.environmentLabel).toBeNull();

    const both = extensionNavEntries([
      {
        environmentId: environmentId("env-1"),
        environmentLabel: "Laptop",
        extensions: [status({ name: "bach", web: web("Bach") })],
      },
      {
        environmentId: environmentId("env-2"),
        environmentLabel: "Desktop",
        extensions: [status({ name: "bach", web: web("Bach") })],
      },
    ]);
    expect(both.map((entry) => entry.environmentLabel)).toEqual(["Laptop", "Desktop"]);
    // The same extension on two environments is two rows, addressable apart.
    expect(findExtensionNavEntry(both, { environmentId: "env-2", name: "bach" })).toBe(both[1]);
  });

  it("normalises badges that draw nothing away", () => {
    const entries = extensionNavEntries([
      {
        environmentId: environmentId("env-1"),
        environmentLabel: "Laptop",
        extensions: [
          status({ name: "a", web: web("A"), badge: { kind: "none" } }),
          status({ name: "b", web: web("B"), badge: { kind: "count", count: 0 } }),
          status({ name: "c", web: web("C"), badge: { kind: "count", count: 3 } }),
          status({ name: "d", web: web("D"), badge: { kind: "dot" } }),
          status({ name: "e", web: web("E") }),
        ],
      },
    ]);

    expect(entries.map((entry) => entry.badge)).toEqual([
      null,
      null,
      { kind: "count", count: 3 },
      { kind: "dot" },
      null,
    ]);
    expect(extensionBadgeTotal(entries)).toEqual({ count: 3, dot: true });
  });

  it("treats a changed folder as a deploy affordance, not a health problem", () => {
    const [entry] = extensionNavEntries([
      {
        environmentId: environmentId("env-1"),
        environmentLabel: "Laptop",
        extensions: [status({ name: "bach", web: web("Bach"), changed: true })],
      },
    ]);

    expect(entry?.changed).toBe(true);
    expect(entry?.available).toBe(true);
    expect(extensionUnavailableMessage(entry!)).toBeNull();
  });

  it("says why a row cannot be mounted, in the extension's own words when it has any", () => {
    const [crashed, disabled, starting] = extensionNavEntries([
      {
        environmentId: environmentId("env-1"),
        environmentLabel: "Laptop",
        extensions: [
          status({
            name: "crashed",
            web: web("Crashed"),
            state: "crashed",
            lastError: "exited with code 1",
          }),
          status({ name: "off", web: web("Off"), state: "disabled", enabled: false }),
          status({ name: "starting", web: web("Starting"), state: "starting" }),
        ],
      },
    ]);

    expect(crashed?.available).toBe(false);
    expect(extensionUnavailableMessage(crashed!)).toBe(
      "Crashed stopped unexpectedly. exited with code 1",
    );
    expect(extensionUnavailableMessage(disabled!)).toContain("turned off");
    expect(extensionUnavailableMessage(starting!)).toBe("Starting is starting.");
  });
});

describe("extension nav icons", () => {
  const web = (label: string, icon?: string) => ({
    entry: "web/entry.js",
    label,
    ...(icon === undefined ? {} : { icon }),
  });

  it("carries the manifest's icon path when it declares one, and nothing when it does not", () => {
    const entries = extensionNavEntries([
      {
        environmentId: environmentId("env-1"),
        environmentLabel: "Laptop",
        extensions: [
          status({ name: "with-icon", web: web("With", "web/icon.svg") }),
          status({ name: "without-icon", web: web("Without") }),
        ],
      },
    ]);

    // The row falls back to the host's own icon when the manifest declares
    // none, so "no icon" has to be visible as an absent path rather than an
    // empty string the client would then try to sign and serve.
    expect(entries[0]?.web.icon).toBe("web/icon.svg");
    expect(entries[1]?.web.icon).toBeUndefined();
  });
});
