// @effect-diagnostics nodeBuiltinImport:off - reads the installed Tailwind's own theme file; a CSS `?raw` import is intercepted by the test runner's CSS handling and arrives without the palette.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { PROJECT_ICON_COLOR_CSS } from "@t3tools/shared/projectIcon";
import { describe, expect, it } from "vite-plus/test";

import { PROJECT_ICON_COLORS } from "./projectIconColors";

// The project-icon colours an extension is sent as CSS values must be the ones
// this app actually draws. Both halves are pinned here, where Tailwind lives:
// the shades the classes use, and the palette values at those shades.
const theme = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("../node_modules/tailwindcss/theme.css", import.meta.url)),
  "utf8",
);
const paletteValue = (color: string, shade: number) =>
  new RegExp(`--color-${color}-${shade}:\\s*([^;]+);`).exec(theme)?.[1]?.trim();

describe("project icon colours sent to extensions", () => {
  it("are drawn at the 600 shade on light themes and 400 on dark", () => {
    for (const { value, className } of PROJECT_ICON_COLORS) {
      expect(className).toBe(`text-${value}-600 dark:text-${value}-400`);
    }
  });

  // The automatic icon's colour is a hash modulo the palette's length, indexed
  // into the order of the table in `@t3tools/shared/projectIcon`. A colour
  // added to the picker, or moved within it, has to move there too or the
  // sidebar and an extension start drawing the same project differently.
  it("are the picker's colours, in the picker's order", () => {
    expect(Object.keys(PROJECT_ICON_COLOR_CSS)).toEqual(
      PROJECT_ICON_COLORS.map(({ value }) => value),
    );
  });

  it("match the installed Tailwind palette at those shades", () => {
    for (const { value } of PROJECT_ICON_COLORS) {
      expect(PROJECT_ICON_COLOR_CSS[value]).toEqual({
        light: paletteValue(value, 600),
        dark: paletteValue(value, 400),
      });
    }
  });
});
