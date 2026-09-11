import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveExtensionProjectIcons } from "./ExtensionProjectIcons.ts";

const project = (overrides: Partial<OrchestrationProjectShell>): OrchestrationProjectShell =>
  ({
    id: "project-1",
    title: "customer-api",
    workspaceRoot: "/code/customer-api",
    faviconPath: null,
    projectIcon: null,
    ...overrides,
  }) as OrchestrationProjectShell;

describe("resolveExtensionProjectIcons", () => {
  it.effect("keeps the three halves apart, in the order the host draws them", () =>
    Effect.gen(function* () {
      const { projects } = yield* resolveExtensionProjectIcons({
        projects: [
          project({
            id: "with-override" as never,
            projectIcon: { kind: "lucide", name: "rocket", color: "violet" },
          }),
          project({ id: "with-emoji" as never, projectIcon: { kind: "emoji", emoji: "🎻" } }),
          project({ id: "plain" as never }),
        ],
        mintFaviconUrl: (candidate) =>
          Effect.succeed(`/api/assets/signed/${candidate.id}/favicon.svg`),
      });

      expect(projects.map((entry) => entry.icon.override)).toEqual([
        {
          kind: "lucide",
          name: "rocket",
          color: "violet",
          // Ready to use: a reader needs no palette of its own.
          colorCss: { light: "oklch(54.1% 0.281 293.009)", dark: "oklch(70.2% 0.183 293.541)" },
        },
        { kind: "emoji", emoji: "🎻" },
        null,
      ]);
      expect(projects[2]?.icon.faviconUrl).toBe("/api/assets/signed/plain/favicon.svg");
      // Always there, so a failed image always has something to fall back to.
      expect(projects.every((entry) => entry.icon.automatic.name.length > 0)).toBe(true);
      expect(projects[2]?.icon.automatic).toEqual({
        name: "server",
        color: "blue",
        colorCss: { light: "oklch(54.6% 0.245 262.881)", dark: "oklch(70.7% 0.165 254.624)" },
      });
    }),
  );

  it.effect("turns the host's 'no favicon' marker into null rather than a URL to load", () =>
    Effect.gen(function* () {
      const { projects } = yield* resolveExtensionProjectIcons({
        projects: [project({})],
        mintFaviconUrl: () => Effect.succeed("/api/assets/signed/project-favicon-missing"),
      });
      expect(projects[0]?.icon.faviconUrl).toBeNull();
    }),
  );

  it.effect("gives an unreadable project the automatic icon instead of failing the list", () =>
    Effect.gen(function* () {
      const { projects } = yield* resolveExtensionProjectIcons({
        projects: [project({ id: "broken" as never }), project({ id: "fine" as never })],
        mintFaviconUrl: (candidate) =>
          candidate.id === ("broken" as never)
            ? Effect.fail("workspace is gone")
            : Effect.succeed("/api/assets/signed/fine/favicon.png"),
      });
      expect(projects.map((entry) => entry.icon.faviconUrl)).toEqual([
        null,
        "/api/assets/signed/fine/favicon.png",
      ]);
    }),
  );
});
