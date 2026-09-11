import { EXTENSION_AUTOMATIC_PROJECT_ICON_NAMES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automaticProjectIcon,
  PROJECT_ICON_COLOR_BY_NAME,
  PROJECT_ICON_LUCIDE_NAMES,
  PROJECT_ICON_NAMES,
} from "./projectIcon.ts";

describe("the automatic project icon", () => {
  it("gives every icon a Lucide name and a colour, so no project renders blank", () => {
    for (const icon of PROJECT_ICON_NAMES) {
      expect(PROJECT_ICON_LUCIDE_NAMES[icon]).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(PROJECT_ICON_COLOR_BY_NAME[icon]).toBeTruthy();
    }
  });

  it("reads the project's name the way the host does", () => {
    expect(automaticProjectIcon("ios-client", "/code/ios-client")).toEqual({
      name: "smartphone",
      color: "lime",
    });
  });

  it("falls back to the folder name, and is stable for the same project", () => {
    const first = automaticProjectIcon("", "/code/customer-api");
    expect(first).toEqual({ name: "server", color: "blue" });
    expect(automaticProjectIcon("", "/code/customer-api")).toEqual(first);
  });
});

describe("the automatic icon's name set", () => {
  it("is exactly the closed set the protocol publishes, in both directions", () => {
    // Every name the model can produce is published, and every published name
    // is producible — so a consumer drawing them from its own copies has all
    // of them, and none it will never be sent.
    const produced = new Set(Object.values(PROJECT_ICON_LUCIDE_NAMES));
    expect([...produced].toSorted()).toEqual(
      [...EXTENSION_AUTOMATIC_PROJECT_ICON_NAMES].toSorted(),
    );
    expect(EXTENSION_AUTOMATIC_PROJECT_ICON_NAMES).toHaveLength(PROJECT_ICON_NAMES.length);
  });
});
