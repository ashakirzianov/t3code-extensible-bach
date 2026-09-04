import { describe, expect, it } from "@effect/vitest";

import { extensionLaunchFlagsFromRecord, resolveExtensionSources } from "./ExtensionSources.ts";

describe("extensionLaunchFlagsFromRecord", () => {
  it("keeps well-formed pairs and trims the path", () => {
    expect(extensionLaunchFlagsFromRecord({ bach: "  /opt/bach  " })).toStrictEqual([
      { name: "bach", path: "/opt/bach" },
    ]);
  });

  it("drops entries a typo made meaningless rather than failing startup", () => {
    expect(
      extensionLaunchFlagsFromRecord({ Bach: "/opt/bach", bach_1: "/x", ok: "", good: "/g" }),
    ).toStrictEqual([{ name: "good", path: "/g" }]);
  });
});

describe("resolveExtensionSources", () => {
  const flags = [{ name: "bach" as const, path: "/shipped/bach" }];

  it("lets a settings entry override the shipped copy by name", () => {
    expect(
      resolveExtensionSources({
        settingsEntries: [{ name: "bach", path: "/checkout/bach/dist", enabled: true }],
        launchFlags: flags,
      }),
    ).toStrictEqual([
      { name: "bach", path: "/checkout/bach/dist", enabled: true, source: "settings" },
    ]);
  });

  it("lets a settings entry disable the shipped copy", () => {
    const [only] = resolveExtensionSources({
      settingsEntries: [{ name: "bach", path: "/shipped/bach", enabled: false }],
      launchFlags: flags,
    });
    expect(only?.enabled).toBe(false);
    expect(only?.source).toBe("settings");
  });

  it("keeps settings order first, then the flags nothing named", () => {
    expect(
      resolveExtensionSources({
        settingsEntries: [
          { name: "notes", path: "/notes", enabled: true },
          { name: "bach", path: "/bach", enabled: true },
        ],
        launchFlags: [...flags, { name: "shipped-only", path: "/shipped/other" }],
      }).map((source) => source.name),
    ).toStrictEqual(["notes", "bach", "shipped-only"]);
  });

  it("ignores a duplicate name within either source", () => {
    expect(
      resolveExtensionSources({
        settingsEntries: [
          { name: "bach", path: "/first", enabled: true },
          { name: "bach", path: "/second", enabled: false },
        ],
        launchFlags: [],
      }),
    ).toStrictEqual([{ name: "bach", path: "/first", enabled: true, source: "settings" }]);
  });
});
