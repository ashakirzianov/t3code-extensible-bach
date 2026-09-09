import type {
  ExtensionSettingsGroup,
  ExtensionSettingsRow,
  ExtensionStateTone,
} from "@t3tools/client-runtime/extensions";
import type { EnvironmentId } from "@t3tools/contracts";
import { extensionToggleAction } from "@t3tools/client-runtime/extensions";
import { ChevronRightIcon, PlusIcon, PuzzleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { requestConfirmDialog } from "../../confirmDialog";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { extensionEnvironment, useExtensionSettingsGroups } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { StartTruncatedPath } from "../StartTruncatedPath";
import {
  confirmAndDeployExtension,
  confirmAndRemoveExtension,
  installExtension,
  toggleExtensionEnabled,
  type ExtensionActionOutcome,
} from "./ExtensionsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/**
 * Settings → Extensions.
 *
 * One section per connected environment, because an extension runs one process
 * per environment and the same name can be installed on two of them with
 * different builds, states and problems. Everything here is live off
 * `extensions.admin.subscribe`, so a crash, a rebuilt folder or a badge change
 * lands without a refresh.
 *
 * Mobile is out of scope for v1: this screen is web-only, and the derivation it
 * renders from lives in `client-runtime` so that stays a decision rather than a
 * rewrite.
 */

const STATE_BADGE_VARIANT: Readonly<
  Record<ExtensionStateTone, "success" | "info" | "secondary" | "error">
> = {
  ok: "success",
  pending: "info",
  muted: "secondary",
  problem: "error",
};

function reportOutcome(outcome: ExtensionActionOutcome): void {
  if (outcome.status !== "failed") return;
  toastManager.add({ type: "error", title: outcome.title, description: outcome.description });
}

function ExtensionLogsPanel({ row }: { row: ExtensionSettingsRow }) {
  const [open, setOpen] = useState(false);
  // Only subscribes once opened: the tail is a per-extension query and there is
  // no reason to hold one per row on a screen that may list a dozen.
  const logs = useEnvironmentQuery(
    open
      ? extensionEnvironment.logs({
          environmentId: row.environmentId,
          input: { name: row.name },
        })
      : null,
  );
  const entries = logs.data?.entries ?? [];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger
          render={
            <Button size="xs" variant="ghost-muted">
              <ChevronRightIcon
                className={cn("transition-transform", open && "rotate-90")}
                aria-hidden="true"
              />
              {open ? "Hide output" : "Show output"}
            </Button>
          }
        />
        {open ? (
          <Button
            aria-label={`Refresh output for ${row.name}`}
            disabled={logs.isPending}
            onClick={logs.refresh}
            size="xs"
            variant="ghost-muted"
          >
            <RefreshCwIcon aria-hidden="true" />
            Refresh
          </Button>
        ) : null}
      </div>
      <CollapsibleContent>
        {logs.error !== null ? (
          <p className="px-1 py-2 text-xs text-destructive-foreground">{logs.error}</p>
        ) : entries.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {logs.isPending ? "Loading output..." : "Nothing on stdout or stderr yet."}
          </p>
        ) : (
          // One `pre` rather than a list: log lines repeat verbatim, so they have
          // no key that is not the index, and a single block is what someone
          // selects and pastes into a bug report.
          <ScrollArea className="mt-1 max-h-64 rounded-md border border-border/60 bg-muted/20">
            <pre className="p-2 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap break-words">
              {entries.map((entry) => entry.line).join("\n")}
            </pre>
          </ScrollArea>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ExtensionCard({ row }: { row: ExtensionSettingsRow }) {
  const deploy = useAtomCommand(extensionEnvironment.deploy);
  const setEnabled = useAtomCommand(extensionEnvironment.setEnabled);
  const toggle = extensionToggleAction(row);

  const remove = useAtomCommand(extensionEnvironment.remove);
  const handleRemove = useCallback(
    async (deleteData: boolean) => {
      reportOutcome(
        await confirmAndRemoveExtension({ row, deleteData, confirm: requestConfirmDialog, remove }),
      );
    },
    [remove, row],
  );

  const handleDeploy = useCallback(async () => {
    reportOutcome(await confirmAndDeployExtension({ row, confirm: requestConfirmDialog, deploy }));
  }, [deploy, row]);

  const handleToggle = useCallback(async () => {
    reportOutcome(
      await toggleExtensionEnabled({
        row,
        nextEnabled: toggle.nextEnabled,
        confirm: requestConfirmDialog,
        setEnabled,
      }),
    );
  }, [row, setEnabled, toggle.nextEnabled]);

  return (
    <div
      className="flex flex-col gap-3 px-3 py-3 sm:px-4"
      data-slot="settings-row"
      id={row.anchorId}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{row.name}</span>
            {row.version === null ? null : (
              <span className="text-xs text-muted-foreground">{row.version}</span>
            )}
            <Badge size="sm" variant={STATE_BADGE_VARIANT[row.stateView.tone]}>
              {row.stateView.label}
            </Badge>
            {row.changed ? (
              <Badge size="sm" variant="warning">
                New build on disk
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{row.sourceLabel}</span>
            <span aria-hidden="true">·</span>
            <StartTruncatedPath className="max-w-full" path={row.path} />
            {row.restartCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {row.restartCount} restart{row.restartCount === 1 ? "" : "s"}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.canDeploy ? (
            <Button onClick={() => void handleDeploy()} size="xs" variant="outline">
              <RefreshCwIcon aria-hidden="true" />
              Deploy
            </Button>
          ) : null}
          <Button
            onClick={() => void handleToggle()}
            size="xs"
            variant={row.enabled ? "ghost-muted" : "outline"}
          >
            {toggle.label}
          </Button>
          <Button onClick={() => void handleRemove(false)} size="xs" variant="ghost-muted">
            Remove
          </Button>
          <Button
            onClick={() => void handleRemove(true)}
            size="xs"
            variant="ghost-muted"
            title="Remove and delete its data directory"
          >
            Remove &amp; delete data
          </Button>
        </div>
      </div>

      {row.tools.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Tools</span>
          {row.tools.map((tool) => (
            <Badge key={tool} size="sm" variant="outline">
              {tool}
            </Badge>
          ))}
        </div>
      ) : null}

      {row.problems.length > 0 ? (
        <ul className="space-y-1">
          {row.problems.map((problem, index) => (
            <li
              key={`${problem.kind}-${problem.subject ?? index}`}
              className="text-xs leading-[1.45] text-destructive-foreground"
            >
              {problem.message}
            </li>
          ))}
        </ul>
      ) : null}

      <ExtensionLogsPanel row={row} />
    </div>
  );
}

/**
 * Adding an extension by path.
 *
 * A path input rather than a folder picker: the folder is on the *server*, which
 * may not be this machine at all, so a native picker would browse the wrong
 * filesystem. The name is not asked for — the manifest supplies it, and the
 * install answers with what it found.
 */
function AddExtensionForm({ environmentId }: { environmentId: EnvironmentId }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const install = useAtomCommand(extensionEnvironment.install);

  // Not memoized: it is used once, by this form's own submit handler.
  const submit = async () => {
    setBusy(true);
    try {
      const outcome = await installExtension({ environmentId, path, install });
      reportOutcome(outcome);
      if (outcome.status === "done") setPath("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        aria-label="Path to a built extension folder"
        className="min-w-0 flex-1"
        onChange={(event) => setPath(event.target.value)}
        placeholder="/path/to/extension/dist"
        size="sm"
        value={path}
      />
      <Button disabled={busy || path.trim().length === 0} size="sm" type="submit" variant="outline">
        <PlusIcon aria-hidden="true" />
        Add extension
      </Button>
    </form>
  );
}

function ExtensionGroup({
  group,
  showLabel,
}: {
  group: ExtensionSettingsGroup;
  showLabel: boolean;
}) {
  return (
    <SettingsSection
      description={
        group.rows.length === 0
          ? "No extensions are installed on this server."
          : "Extensions run as separate processes and contribute tools, routes and screens."
      }
      icon={<PuzzleIcon className="size-3.5" />}
      id={`extensions-${group.environmentId}`}
      title={showLabel ? group.environmentLabel : "Extensions"}
    >
      {group.rows.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          Point this server at a built extension folder to add one.
        </p>
      ) : (
        group.rows.map((row) => <ExtensionCard key={row.anchorId} row={row} />)
      )}
      <AddExtensionForm environmentId={group.environmentId} />
    </SettingsSection>
  );
}

export function ExtensionsSettingsPanel() {
  const groups = useExtensionSettingsGroups();
  const showLabel = groups.length > 1;

  return (
    <SettingsPageContainer>
      {groups.length === 0 ? (
        <SettingsSection
          icon={<PuzzleIcon className="size-3.5" />}
          id="extensions"
          title="Extensions"
          description="Connect to a server to see the extensions installed on it."
        >
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">No server is connected.</p>
        </SettingsSection>
      ) : (
        groups.map((group) => (
          <ExtensionGroup group={group} key={group.environmentId} showLabel={showLabel} />
        ))
      )}
    </SettingsPageContainer>
  );
}

/** Where the sidebar's redeploy affordance sends someone. */
export function useNavigateToExtensionSettings(): (input: {
  readonly environmentId: string;
  readonly name: string;
}) => void {
  const navigate = useNavigate();
  return useCallback(
    (input) => {
      void navigate({
        to: "/settings/extensions",
        hash: `extension-${input.environmentId}-${input.name}`,
      });
    },
    [navigate],
  );
}
