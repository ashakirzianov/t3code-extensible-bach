import { useAtomValue } from "@effect/atom-react";
import type { ExtensionNavEntry } from "@t3tools/client-runtime/extensions";
import { PuzzleIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { cn } from "../lib/utils";
import { useDeployExtension } from "../components/settings/ExtensionsSettings";
import { extensionEnvironment, useExtensionNavEntries } from "../state/extensions";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { Button } from "../components/ui/button";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

/**
 * The nav rows the host draws for extensions.
 *
 * The host draws them, not the extension: an extension contributes a label, an
 * icon path and a badge, and never markup. That is what keeps a badly behaved
 * extension from being able to misdraw the host's chrome, and what lets the
 * rows match whatever the sidebar looks like next year.
 *
 * There is one row per (environment, extension), because an extension runs one
 * process per environment and the two instances are genuinely different things
 * to look at.
 */

const badgeLabel = (entry: ExtensionNavEntry): string | null => {
  if (entry.badge === null) return null;
  if (entry.badge.kind === "dot") return "";
  return entry.badge.count > 99 ? "99+" : String(entry.badge.count);
};

/**
 * The manifest's icon, or `null` to fall back.
 *
 * The URL is signed and short-lived, so it is queried rather than derived — and
 * an extension with no icon never asks for one.
 */
function useExtensionIconUrl(entry: ExtensionNavEntry): string | null {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(entry.environmentId);
  const result = useAtomValue(
    extensionEnvironment.assetUrlsQuery({
      environmentId: entry.environmentId,
      input: { name: entry.name },
    }),
  );
  const urls = Option.getOrNull(AsyncResult.value(result));
  if (entry.web.icon === undefined || urls?.icon === undefined || httpBaseUrl === null) return null;
  try {
    return new URL(urls.icon, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

function ExtensionSidebarRow({ entry }: { entry: ExtensionNavEntry }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const deployExtension = useDeployExtension();
  const isActive = useLocation({
    select: (location) => location.pathname.startsWith(`/ext/${entry.environmentId}/${entry.name}`),
  });
  const badge = badgeLabel(entry);
  const iconUrl = useExtensionIconUrl(entry);

  const handleOpen = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/ext/$environmentId/$name/$",
      params: { environmentId: entry.environmentId, name: entry.name, _splat: "" },
    });
  }, [entry.environmentId, entry.name, isMobile, navigate, setOpenMobile]);

  // Deploy is a human click and the confirmation is the gate, so the row asks
  // it here rather than sending someone to Settings to press the same button
  // again. It is the screen's own `useDeployExtension`, not a second
  // implementation — same confirmation, same command, same failure toast.
  const handleRedeploy = useCallback(() => {
    void deployExtension({ environmentId: entry.environmentId, name: entry.name });
  }, [deployExtension, entry.environmentId, entry.name]);

  return (
    <SidebarMenuItem className="relative">
      <SidebarMenuButton
        data-active={isActive ? "" : undefined}
        onClick={handleOpen}
        title={entry.environmentLabel === null ? undefined : entry.environmentLabel}
      >
        {iconUrl === null ? (
          <PuzzleIcon className={cn(!entry.available && "opacity-50")} />
        ) : (
          // An extension's own artwork, drawn as an image rather than inlined:
          // an SVG in an `<img>` cannot run script or reach the host's DOM.
          <img
            alt=""
            aria-hidden="true"
            className={cn("size-4 shrink-0", !entry.available && "opacity-50")}
            src={iconUrl}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
        {entry.environmentLabel === null ? null : (
          <span className="shrink-0 truncate text-xs text-sidebar-muted-foreground/70">
            {entry.environmentLabel}
          </span>
        )}
        {badge === null ? null : (
          // The badge occupies the same 16px box, 8px in from the row's end,
          // as the icon of the footer button below it (16px centred in a 32px
          // square), so the two share a vertical centre line. A dot is centred
          // in that box; a count wider than one digit grows leftwards from it.
          <span className="flex h-4 min-w-4 shrink-0 items-center justify-center">
            <span
              className={cn(
                "rounded-full bg-primary text-primary-foreground",
                badge === "" ? "size-1.5" : "min-w-4 px-1 text-center text-3xs leading-4",
              )}
            >
              {badge}
            </span>
          </span>
        )}
      </SidebarMenuButton>
      {entry.changed ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Deploy the new build of ${entry.label}`}
                className="absolute top-1/2 right-1.5 size-5 -translate-y-1/2"
                onClick={handleRedeploy}
                size="icon-xs"
                variant="ghost-muted"
              />
            }
          >
            <RefreshCwIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="right">A new build is on disk. Deploy it.</TooltipPopup>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}

export const ExtensionSidebarEntries = memo(function ExtensionSidebarEntries() {
  const allEntries = useExtensionNavEntries();
  // A disabled extension gets no row: turning it off is a deliberate choice,
  // and Settings → Extensions is where it is turned back on. Only the sidebar
  // drops it — the route still resolves it, to say it is turned off. A stopped
  // or crashed extension keeps its dimmed row, because nobody chose that.
  const entries = useMemo(
    () => allEntries.filter((entry) => entry.state !== "disabled"),
    [allEntries],
  );
  if (entries.length === 0) return null;
  return (
    // Rows sit 8px in rather than a labelled row's usual 10px: they stack
    // directly above the footer's icon-only buttons, which centre a 16px icon
    // in a 32px square, and the 2px step shows between the two. Set through
    // the inset variable the button's own size reads, at both ends.
    <SidebarMenu className="[--sidebar-row-content-inset:--spacing(2)]">
      {entries.map((entry) => (
        <ExtensionSidebarRow key={`${entry.environmentId}:${entry.name}`} entry={entry} />
      ))}
    </SidebarMenu>
  );
});
