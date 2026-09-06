import type { ExtensionNavEntry } from "@t3tools/client-runtime/extensions";
import { PuzzleIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { requestConfirmDialog } from "../confirmDialog";
import { useAtomCommand } from "../state/use-atom-command";
import { cn } from "../lib/utils";
import { extensionEnvironment, useExtensionNavEntries } from "../state/extensions";
import { Button } from "../components/ui/button";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar";
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

const tooltipLabel = (entry: ExtensionNavEntry): string =>
  entry.environmentLabel === null ? entry.label : `${entry.label} — ${entry.environmentLabel}`;

function ExtensionSidebarEntry({ entry }: { entry: ExtensionNavEntry }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const deploy = useAtomCommand(extensionEnvironment.deploy);
  const isActive = useLocation({
    select: (location) => location.pathname.startsWith(`/ext/${entry.environmentId}/${entry.name}`),
  });
  const badge = badgeLabel(entry);

  const handleOpen = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/ext/$environmentId/$name/$",
      params: { environmentId: entry.environmentId, name: entry.name, _splat: "" },
    });
  }, [entry.environmentId, entry.name, isMobile, navigate, setOpenMobile]);

  // Deploy is stop, rehash, start. It is a human click in host UI and nothing
  // an extension or an agent can reach, so the confirmation is the host's and
  // says what it will actually do.
  const handleDeploy = useCallback(async () => {
    const confirmed = await requestConfirmDialog(
      `Deploy the new build of ${entry.label}?\nThe extension stops and starts again on the build that is on disk now.`,
    );
    if (confirmed !== true) return;
    await deploy({ environmentId: entry.environmentId, input: { name: entry.name } });
  }, [deploy, entry.environmentId, entry.label, entry.name]);

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={tooltipLabel(entry)}
              className="relative"
              data-active={isActive ? "" : undefined}
              onClick={handleOpen}
              size="icon"
            >
              <PuzzleIcon className={cn(!entry.available && "opacity-50")} />
              {badge !== null ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute top-0.5 right-0.5 rounded-full bg-primary text-primary-foreground",
                    badge === ""
                      ? "size-1.5"
                      : "min-w-3.5 px-0.5 text-center text-[0.625rem] leading-3.5",
                  )}
                >
                  {badge}
                </span>
              ) : null}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{tooltipLabel(entry)}</TooltipPopup>
      </Tooltip>
      {entry.changed ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Deploy the new build of ${entry.label}`}
                className="absolute -right-1 -bottom-1 size-4 rounded-full"
                onClick={() => void handleDeploy()}
                size="icon-xs"
                variant="ghost-muted"
              />
            }
          >
            <RefreshCwIcon className="size-2.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">A new build is on disk. Deploy it.</TooltipPopup>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}

export const ExtensionSidebarEntries = memo(function ExtensionSidebarEntries() {
  const entries = useExtensionNavEntries();
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((entry) => (
        <ExtensionSidebarEntry key={`${entry.environmentId}:${entry.name}`} entry={entry} />
      ))}
    </>
  );
});
