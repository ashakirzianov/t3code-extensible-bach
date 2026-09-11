import type { ExtensionAutomaticProjectIconName, ProjectIconColor } from "@t3tools/contracts";

/**
 * The automatic project icon: what every client draws for a project that has
 * neither an icon of its own (Project settings) nor a favicon.
 *
 * Shared rather than living in the web app because the host is not its only
 * reader — an extension gets the same icon from `extensions.projectIcons`, and
 * a second copy is how the command palette once drifted from the sidebar.
 */
export const PROJECT_ICON_NAMES = [
  "ai",
  "book",
  "cloud",
  "database",
  "desktop",
  "game",
  "image",
  "mobile",
  "music",
  "package",
  "security",
  "server",
  "shopping",
  "terminal",
  "test",
  "video",
  "web",
  "code",
  "braces",
  "circuit",
  "folder-code",
  "layers",
] as const;

export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];

export type ProjectIconSelection =
  | { readonly kind: "lucide"; readonly icon: ProjectIconName }
  | { readonly kind: "emoji"; readonly icon: ProjectIconName; readonly emoji: string };

interface ProjectIconClass {
  readonly icon: ProjectIconName;
  readonly terms: ReadonlyArray<string>;
}

const PROJECT_ICON_MODEL: ReadonlyArray<ProjectIconClass> = [
  { icon: "ai", terms: ["ai", "agent", "bot", "gpt", "llm", "ml", "model", "neural"] },
  {
    icon: "mobile",
    terms: ["android", "expo", "ios", "mobile", "native", "reactnative", "swift"],
  },
  {
    icon: "desktop",
    terms: ["desktop", "electron", "linux", "mac", "macos", "tauri", "windows"],
  },
  {
    icon: "book",
    terms: ["book", "docs", "documentation", "guide", "handbook", "manual", "wiki"],
  },
  {
    icon: "security",
    terms: ["auth", "identity", "oauth", "security", "sso", "vault"],
  },
  {
    icon: "database",
    terms: [
      "analytics",
      "data",
      "database",
      "db",
      "mongo",
      "mysql",
      "postgres",
      "redis",
      "sql",
      "storage",
    ],
  },
  {
    icon: "cloud",
    terms: [
      "aws",
      "azure",
      "cloud",
      "deploy",
      "devops",
      "docker",
      "gcp",
      "infra",
      "kubernetes",
      "terraform",
    ],
  },
  {
    icon: "server",
    terms: ["api", "backend", "gateway", "server", "service", "worker"],
  },
  {
    icon: "terminal",
    terms: ["automation", "bash", "cli", "command", "script", "shell", "terminal"],
  },
  {
    icon: "package",
    terms: ["component", "kit", "lib", "library", "package", "plugin", "sdk", "toolkit"],
  },
  {
    icon: "test",
    terms: ["benchmark", "e2e", "fixture", "spec", "test", "testing"],
  },
  {
    icon: "shopping",
    terms: ["cart", "commerce", "market", "shop", "store"],
  },
  { icon: "game", terms: ["game", "gaming", "play"] },
  { icon: "music", terms: ["audio", "music", "podcast", "radio", "sound"] },
  { icon: "video", terms: ["film", "movie", "stream", "video"] },
  { icon: "image", terms: ["camera", "gallery", "image", "photo", "picture"] },
  {
    icon: "web",
    terms: [
      "browser",
      "frontend",
      "nextjs",
      "react",
      "site",
      "svelte",
      "ui",
      "vue",
      "web",
      "website",
    ],
  },
];

const GENERIC_PROJECT_ICONS: ReadonlyArray<ProjectIconName> = [
  "code",
  "braces",
  "circuit",
  "folder-code",
  "layers",
];

const projectIconCache = new Map<string, ProjectIconSelection>();

function projectNameTokens(value: string): ReadonlyArray<string> {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
}

function termScore(token: string, term: string): number {
  if (token === term) return 3;
  if (term.length >= 4 && (token.startsWith(term) || token.endsWith(term))) return 1;
  return 0;
}

function stableIndex(value: string, length: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % length;
}

export function selectProjectIcon(
  projectName: string,
  workspaceRoot: string,
): ProjectIconSelection {
  const name = projectName.trim() || workspaceRoot.split(/[\\/]+/).findLast(Boolean) || "project";
  const cacheKey = name.toLowerCase();
  const cachedIcon = projectIconCache.get(cacheKey);
  if (cachedIcon) return cachedIcon;

  const tokens = projectNameTokens(name);
  let bestIcon: ProjectIconName | null = null;
  let bestScore = 0;

  for (const projectClass of PROJECT_ICON_MODEL) {
    let score = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      for (const term of projectClass.terms) {
        tokenScore = Math.max(tokenScore, termScore(token, term));
      }
      score += tokenScore;
    }
    if (score > bestScore) {
      bestIcon = projectClass.icon;
      bestScore = score;
    }
  }

  const iconName =
    bestIcon ?? GENERIC_PROJECT_ICONS[stableIndex(cacheKey, GENERIC_PROJECT_ICONS.length)]!;
  const icon: ProjectIconSelection = { kind: "lucide", icon: iconName };
  projectIconCache.set(cacheKey, icon);
  return icon;
}

/** The colour the host draws each automatic icon in. */
export const PROJECT_ICON_COLOR_BY_NAME: Readonly<Record<ProjectIconName, ProjectIconColor>> = {
  ai: "violet",
  book: "amber",
  braces: "purple",
  circuit: "teal",
  cloud: "sky",
  code: "blue",
  database: "cyan",
  desktop: "indigo",
  "folder-code": "orange",
  game: "emerald",
  image: "pink",
  layers: "fuchsia",
  mobile: "lime",
  music: "fuchsia",
  package: "orange",
  security: "teal",
  server: "blue",
  shopping: "rose",
  terminal: "green",
  test: "yellow",
  video: "red",
  web: "sky",
};

/**
 * Each automatic icon by its canonical Lucide name — the same vocabulary as a
 * user's own `lucide` icon override, so a reader renders both one way.
 */
export const PROJECT_ICON_LUCIDE_NAMES: Readonly<
  Record<ProjectIconName, ExtensionAutomaticProjectIconName>
> = {
  ai: "bot",
  book: "book-open",
  braces: "braces",
  circuit: "circuit-board",
  cloud: "cloud-cog",
  code: "code-xml",
  database: "database",
  desktop: "monitor",
  "folder-code": "folder-code",
  game: "gamepad-2",
  image: "image",
  layers: "layers",
  mobile: "smartphone",
  music: "music",
  package: "package",
  security: "shield-check",
  server: "server",
  shopping: "shopping-bag",
  terminal: "terminal",
  test: "flask-conical",
  video: "video",
  web: "earth",
};

/** The automatic icon for a project, as a Lucide name and a palette colour. */
export function automaticProjectIcon(
  title: string,
  workspaceRoot: string,
): { readonly name: ExtensionAutomaticProjectIconName; readonly color: ProjectIconColor } {
  const selection = selectProjectIcon(title, workspaceRoot);
  return {
    name: PROJECT_ICON_LUCIDE_NAMES[selection.icon],
    color: PROJECT_ICON_COLOR_BY_NAME[selection.icon],
  };
}

/**
 * The CSS colour the host draws each palette colour in: Tailwind's default
 * palette at the 600 shade on light themes and 400 on dark (the host's
 * `text-<color>-600 dark:text-<color>-400`, `projectIconColors.ts`). Given as
 * values rather than names so a reader outside the host's stylesheet — an
 * extension inlining its own SVG — needs no palette of its own. A test in the
 * web app pins these against the installed Tailwind.
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
