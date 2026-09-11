import type {
  ExtensionProjectIcon,
  ExtensionProjectIconsResult,
  OrchestrationProjectShell,
  ProjectIconColor,
} from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { automaticProjectIcon, PROJECT_ICON_COLOR_CSS } from "@t3tools/shared/projectIcon";
import * as Effect from "effect/Effect";

/**
 * Answering `extensions.projectIcons`: each project's icon the way the host's
 * own sidebar resolves it (`ProjectFavicon`), as its three halves.
 *
 * The favicon is minted through the same asset path the sidebar uses, so an
 * extension gets the same signed URL and the same "none found" answer. That
 * answer arrives as a marker URL rather than an error; it becomes `null` here,
 * because a marker is not something an extension should try to load.
 */
/** A palette colour with the CSS value the host draws it in attached. */
const withColorCss = <A extends { readonly color: ProjectIconColor }>(icon: A) => ({
  ...icon,
  colorCss: PROJECT_ICON_COLOR_CSS[icon.color],
});

const toOverride = (
  override: OrchestrationProjectShell["projectIcon"],
): ExtensionProjectIcon["override"] => {
  if (override === null || override === undefined) return null;
  return override.kind === "lucide" ? withColorCss(override) : override;
};

export const resolveExtensionProjectIcons = Effect.fn("extensions.projectIcons")(function* <
  E,
  R,
>(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  /** The sidebar's favicon URL for this project, page-relative. */
  readonly mintFaviconUrl: (project: OrchestrationProjectShell) => Effect.Effect<string, E, R>;
}) {
  const projects = yield* Effect.forEach(
    input.projects,
    (project) =>
      input.mintFaviconUrl(project).pipe(
        // One unreadable project must not cost every other its icon; it falls
        // back to the automatic one, as it would in the sidebar.
        Effect.orElseSucceed(() => null),
        Effect.map((url) => ({
          projectId: project.id,
          icon: {
            override: toOverride(project.projectIcon),
            faviconUrl: url === null || isProjectFaviconFallbackUrl(url) ? null : url,
            automatic: withColorCss(automaticProjectIcon(project.title, project.workspaceRoot)),
          } satisfies ExtensionProjectIcon,
        })),
      ),
    { concurrency: 4 },
  );
  return { projects } satisfies ExtensionProjectIconsResult;
});
