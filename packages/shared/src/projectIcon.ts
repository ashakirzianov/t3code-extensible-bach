import type { ProjectIconColor } from "@t3tools/contracts";

/**
 * The automatic project icon: what every client draws for a project that has
 * neither an icon of its own (Project settings) nor a favicon.
 *
 * It is a monogram — one or two letters from the project's name — on a colour
 * hashed from the same name. Nothing is guessed from the name's meaning: a
 * keyword-derived Lucide icon used to be the answer here, and it was wrong
 * often enough that two projects called `api` and `api-v2` looked identical
 * while `Nebula` got a dice.
 *
 * Shared rather than living in the web app because the host is not its only
 * reader — an extension gets the same icon from `extensions.projectIcons`, and
 * a second copy is how the command palette once drifted from the sidebar.
 * `apps/web/src/projectIdentity.ts` re-exports this; there is no other
 * implementation.
 */

/**
 * The CSS colour the host draws each palette colour in: Tailwind's default
 * palette at the 600 shade on light themes and 400 on dark (the host's
 * `text-<color>-600 dark:text-<color>-400`, `projectIconColors.ts`). Given as
 * values rather than names so a reader outside the host's stylesheet — an
 * extension inlining its own SVG — needs no palette of its own. A test in the
 * web app pins these against the installed Tailwind.
 *
 * The order is also the palette's order, which the hashed colour indexes into;
 * the same test pins it against the picker's list.
 */
export const PROJECT_ICON_COLOR_CSS: Readonly<
  Record<ProjectIconColor, { readonly light: string; readonly dark: string }>
> = {
  gray: { light: "oklch(44.6% 0.03 256.802)", dark: "oklch(70.7% 0.022 261.325)" },
  red: { light: "oklch(57.7% 0.245 27.325)", dark: "oklch(70.4% 0.191 22.216)" },
  orange: { light: "oklch(64.6% 0.222 41.116)", dark: "oklch(75% 0.183 55.934)" },
  amber: { light: "oklch(66.6% 0.179 58.318)", dark: "oklch(82.8% 0.189 84.429)" },
  yellow: { light: "oklch(68.1% 0.162 75.834)", dark: "oklch(85.2% 0.199 91.936)" },
  lime: { light: "oklch(64.8% 0.2 131.684)", dark: "oklch(84.1% 0.238 128.85)" },
  green: { light: "oklch(62.7% 0.194 149.214)", dark: "oklch(79.2% 0.209 151.711)" },
  emerald: { light: "oklch(59.6% 0.145 163.225)", dark: "oklch(76.5% 0.177 163.223)" },
  teal: { light: "oklch(60% 0.118 184.704)", dark: "oklch(77.7% 0.152 181.912)" },
  cyan: { light: "oklch(60.9% 0.126 221.723)", dark: "oklch(78.9% 0.154 211.53)" },
  sky: { light: "oklch(58.8% 0.158 241.966)", dark: "oklch(74.6% 0.16 232.661)" },
  blue: { light: "oklch(54.6% 0.245 262.881)", dark: "oklch(70.7% 0.165 254.624)" },
  indigo: { light: "oklch(51.1% 0.262 276.966)", dark: "oklch(67.3% 0.182 276.935)" },
  violet: { light: "oklch(54.1% 0.281 293.009)", dark: "oklch(70.2% 0.183 293.541)" },
  purple: { light: "oklch(55.8% 0.288 302.321)", dark: "oklch(71.4% 0.203 305.504)" },
  fuchsia: { light: "oklch(59.1% 0.293 322.896)", dark: "oklch(74% 0.238 322.16)" },
  pink: { light: "oklch(59.2% 0.249 0.584)", dark: "oklch(71.8% 0.202 349.761)" },
  rose: { light: "oklch(58.6% 0.253 17.585)", dark: "oklch(71.2% 0.194 13.428)" },
};

/**
 * The palette, in the order the picker offers it. Read off the table above
 * rather than written twice: the hashed colour is an index into this, and a
 * second list would be a second thing to keep in step.
 */
const PROJECT_ICON_PALETTE = Object.keys(PROJECT_ICON_COLOR_CSS) as ReadonlyArray<ProjectIconColor>;

/** Visual identity tokens for a generated project badge. */
export interface ProjectIdentity {
  readonly monogram: string;
  readonly color: ProjectIconColor;
}

function normalizeProjectName(projectName: string): string {
  return projectName.normalize("NFKC").trim();
}

function projectMonogram(projectName: string): string {
  const words = normalizeProjectName(projectName).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

function projectColor(projectName: string): ProjectIconColor {
  const seed = normalizeProjectName(projectName).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_PALETTE.length;
  }
  return PROJECT_ICON_PALETTE[index] ?? "blue";
}

/** Derives the stable monogram and generated colors used when a project has no icon. */
export function deriveProjectIdentity(projectName: string): ProjectIdentity {
  return {
    monogram: projectMonogram(projectName),
    color: projectColor(projectName),
  };
}

/**
 * The automatic icon for a project, as the monogram to draw and the palette
 * colour to draw it in. The title is the only input, exactly as in the
 * sidebar — an extension and the host must land on the same badge.
 */
export function automaticProjectIcon(title: string): {
  readonly text: string;
  readonly color: ProjectIconColor;
} {
  const identity = deriveProjectIdentity(title);
  return { text: identity.monogram, color: identity.color };
}
