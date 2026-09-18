import { describe, expect, it } from "vite-plus/test";

import { automaticProjectIcon, PROJECT_ICON_COLOR_CSS } from "./projectIcon.ts";

describe("the automatic project icon", () => {
  it("is the project's monogram on a colour hashed from its name", () => {
    expect(automaticProjectIcon("Silver Orchard").text).toBe("SO");
    expect(automaticProjectIcon("ios-client").text).toBe("IC");
    expect(automaticProjectIcon("m7forge").text).toBe("M7");
    // Two projects whose names differ get told apart by the colour too.
    expect(automaticProjectIcon("Nebula").color).not.toBe(automaticProjectIcon("Juniper").color);
  });

  it("never renders blank: an unnameable project still gets a badge", () => {
    expect(automaticProjectIcon("").text).toBe("PR");
    expect(automaticProjectIcon("---").text).toBe("PR");
  });

  it("is stable for the same project, and ignores case and surrounding space", () => {
    expect(automaticProjectIcon("  NEBULA  ").color).toBe(automaticProjectIcon("Nebula").color);
    expect(automaticProjectIcon("Nebula")).toEqual(automaticProjectIcon("Nebula"));
  });

  it("only ever picks a colour the host has a CSS value for", () => {
    for (const name of ["Jobs", "Scripts and Extractors", "T3", "文書", "", "---"]) {
      expect(PROJECT_ICON_COLOR_CSS[automaticProjectIcon(name).color]).toBeTruthy();
    }
  });
});
