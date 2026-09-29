import type {
  ExtensionDeployTarget,
  ExtensionSettingsGroup,
  ExtensionSettingsRow,
  ExtensionStateTone,
} from "@t3tools/client-runtime/extensions";
import type { EnvironmentId, FilesystemBrowseEntry } from "@t3tools/contracts";
import { filterFilesystemBrowseEntries } from "@t3tools/client-runtime/state/filesystem";
import { appendBrowsePathSegment } from "@t3tools/client-runtime/state/projects";
import { extensionToggleAction } from "@t3tools/client-runtime/extensions";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { extensionEnvironment, useExtensionSettingsGroups } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveProjectPickerTarget } from "../../wslPaths";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { StartTruncatedPath } from "../StartTruncatedPath";
import {
  confirmAndDeployExtension,
  confirmAndRemoveExtension,
  canPickExtensionFolderNatively,
  confirmAndChangeExtensionPath,
  extensionBrowsePlatform,
  extensionFolderBrowseRequest,
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

/**
 * Deploy, from wherever it is offered.
 *
 * The confirmation is the gate and it is imperative, so it needs no screen of
 * its own — which is what lets the sidebar's "new build on disk" affordance be
 * one click rather than a trip to this screen to press the same button again.
 */
export function useDeployExtension(): (target: ExtensionDeployTarget) => Promise<void> {
  const deploy = useAtomCommand(extensionEnvironment.deploy);
  return useCallback(
    async (target) => {
      reportOutcome(
        await confirmAndDeployExtension({ target, confirm: requestConfirmDialog, deploy }),
      );
    },
    [deploy],
  );
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
          <div className="mt-1 overflow-hidden rounded-md border border-border/60 bg-muted/20">
            <ScrollArea className="max-h-64">
              <pre className="p-2 font-mono text-2xs whitespace-pre-wrap break-words">
                {entries.map((entry) => entry.line).join("\n")}
              </pre>
            </ScrollArea>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ExtensionCard({ row }: { row: ExtensionSettingsRow }) {
  const deployExtension = useDeployExtension();
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

  const [editingPath, setEditingPath] = useState(false);

  const handleDeploy = useCallback(async () => {
    await deployExtension(row);
  }, [deployExtension, row]);

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

            {row.hasInstructions ? (
              <>
                <span aria-hidden="true">·</span>
                <span>Adds MCP instructions</span>
              </>
            ) : null}
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
          <Button
            aria-expanded={editingPath}
            onClick={() => setEditingPath((current) => !current)}
            size="xs"
            variant="ghost-muted"
          >
            Change path…
          </Button>
          {/* A launch flag would start it again on the next reconcile, so there
              is nothing to remove; Disable is its way out. */}
          {row.canRemove ? (
            <>
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
            </>
          ) : null}
        </div>
      </div>

      {editingPath ? (
        <ChangeExtensionPathForm onClose={() => setEditingPath(false)} row={row} />
      ) : null}

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

      {row.resources.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Resources</span>
          {row.resources.map((uri) => (
            <Badge key={uri} size="sm" variant="outline">
              {uri}
            </Badge>
          ))}
        </div>
      ) : null}

      {row.problems.length > 0 ? (
        <ul className="space-y-1">
          {row.problems.map((problem, index) => (
            <li
              key={`${problem.kind}-${problem.subject ?? index}`}
              className="text-xs leading-normal text-destructive-foreground"
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

const EMPTY_BROWSE_ENTRIES: ReadonlyArray<FilesystemBrowseEntry> = [];

/**
 * Choosing a built extension folder on a server.
 *
 * The folder lives on the *server* the extension will run on, which may not be
 * this device, so the typeahead lists folders through that server's own
 * `filesystem.browse` — the same mechanism Add project uses, and correct for a
 * local, desktop-secondary or remote environment alike. The native dialog is
 * offered only when it would browse that same filesystem (see
 * `canPickExtensionFolderNatively`). Either way the choice lands in `value`;
 * what to do with it is the caller's.
 *
 * Renders as siblings (the field, then "Browse…") so it slots into the
 * caller's own flex row next to its buttons.
 */
function ExtensionFolderPicker({
  environmentId,
  value,
  onValueChange,
  ariaLabel,
}: {
  environmentId: EnvironmentId;
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const environment = useEnvironment(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();

  const platform = extensionBrowsePlatform(environment?.serverConfig?.environment.platform.os);
  const browseRequest = extensionFolderBrowseRequest(value, platform);
  const browse = useEnvironmentQuery(
    browseRequest === null
      ? null
      : filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browseRequest.partialPath },
        }),
  );
  const browseEntries = browse.data?.entries ?? EMPTY_BROWSE_ENTRIES;
  const filterQuery = browseRequest?.filterQuery ?? "";
  const { visibleEntries } = useMemo(
    () => filterFilesystemBrowseEntries(browseEntries, filterQuery),
    [browseEntries, filterQuery],
  );

  const isDesktopLocal =
    environment !== null && isDesktopLocalConnectionTarget(environment.entry.target);
  // The desktop routes its dialog by pool instance id, which only the bootstrap
  // list knows; match it on backend URL the way the Add project palette does.
  const desktopInstanceId =
    isDesktopLocal && environment.displayUrl !== null
      ? (desktopLocalBootstraps.find(
          (bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl,
        )?.id ?? null)
      : null;
  const canPickNatively = canPickExtensionFolderNatively({
    environmentId,
    primaryEnvironmentId,
    isDesktopLocal,
    desktopInstanceId,
    hasDesktopBridge: typeof window !== "undefined" && window.desktopBridge !== undefined,
  });

  // Not memoized: used once, by this picker's own button.
  const pickFolder = async () => {
    const api = readLocalApi();
    if (!api) return;
    // A WSL-only primary is still routed to its distro, as in the palette.
    const wslConfiguration =
      environmentId === primaryEnvironmentId && platform === "Linux"
        ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
        : null;
    const targetEnvironmentId = resolveProjectPickerTarget({
      browseEnvironmentId: environmentId,
      primaryEnvironmentId,
      desktopInstanceId,
      wslConfiguration,
    });
    // Start where the typeahead has got to — the server's resolved directory,
    // so a `~/` the dialog would not expand never reaches it.
    const initialPath = browse.data?.parentPath ?? null;
    const picked = await api.dialogs
      .pickFolder({
        ...(initialPath === null ? {} : { initialPath }),
        ...(targetEnvironmentId === null ? {} : { targetEnvironmentId }),
      })
      .catch(() => null);
    if (picked) onValueChange(picked);
  };

  return (
    <>
      <div className="min-w-0 flex-1">
        <Autocomplete
          items={visibleEntries}
          itemToStringValue={(entry) => entry.fullPath}
          mode="none"
          openOnInputClick
          open={suggestionsOpen && visibleEntries.length > 0}
          onOpenChange={setSuggestionsOpen}
          value={value}
          onValueChange={(next, eventDetails) => {
            if (eventDetails.reason === "item-press") {
              // Choosing a folder descends into it rather than stopping there:
              // an extension is usually a build folder a level or two down.
              const entry = visibleEntries.find((candidate) => candidate.fullPath === next);
              if (entry) {
                onValueChange(appendBrowsePathSegment(value, entry.name));
                return;
              }
            }
            onValueChange(next);
          }}
        >
          <AutocompleteInput
            aria-label={ariaLabel}
            placeholder="~/path/to/extension/dist"
            size="sm"
            spellCheck={false}
          />
          <AutocompletePopup>
            <AutocompleteList className="max-h-72">
              {visibleEntries.map((entry) => (
                <AutocompleteItem key={entry.fullPath} value={entry}>
                  <FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{entry.name}</span>
                </AutocompleteItem>
              ))}
            </AutocompleteList>
          </AutocompletePopup>
        </Autocomplete>
      </div>
      {canPickNatively ? (
        <Button onClick={() => void pickFolder()} size="sm" type="button" variant="outline">
          <FolderOpenIcon aria-hidden="true" />
          Browse…
        </Button>
      ) : null}
    </>
  );
}

/**
 * Adding an extension by picking its built folder. The manifest supplies the
 * name, and the install answers with what it found.
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
      <ExtensionFolderPicker
        ariaLabel="Path to a built extension folder on this server"
        environmentId={environmentId}
        onValueChange={setPath}
        value={path}
      />
      <Button disabled={busy || path.trim().length === 0} size="sm" type="submit" variant="outline">
        <PlusIcon aria-hidden="true" />
        Add extension
      </Button>
      <p className="w-full text-xs text-muted-foreground">
        Extensions run as separate processes and contribute tools, routes and screens. Type a path
        on this server — suggestions come from its own filesystem.
      </p>
    </form>
  );
}

/**
 * Repointing an installed extension: the same picker, starting from the folder
 * it runs from now. For a flag-started extension, saving writes the override.
 */
function ChangeExtensionPathForm({
  row,
  onClose,
}: {
  row: ExtensionSettingsRow;
  onClose: () => void;
}) {
  const [path, setPath] = useState(row.path);
  const [busy, setBusy] = useState(false);
  const setPathCommand = useAtomCommand(extensionEnvironment.setPath);

  // Not memoized: it is used once, by this form's own submit handler.
  const submit = async () => {
    setBusy(true);
    try {
      const outcome = await confirmAndChangeExtensionPath({
        row,
        path,
        confirm: requestConfirmDialog,
        setPath: setPathCommand,
      });
      reportOutcome(outcome);
      if (outcome.status === "done") onClose();
    } finally {
      setBusy(false);
    }
  };

  const unchanged = path.trim().length === 0 || path.trim() === row.path;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ExtensionFolderPicker
        ariaLabel={`New folder for ${row.name}`}
        environmentId={row.environmentId}
        onValueChange={setPath}
        value={path}
      />
      <Button disabled={busy || unchanged} size="sm" type="submit" variant="outline">
        Save
      </Button>
      <Button onClick={onClose} size="sm" type="button" variant="ghost-muted">
        Cancel
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
      icon={<PuzzleIcon className="size-3.5" />}
      id={`extensions-${group.environmentId}`}
      title={showLabel ? group.environmentLabel : "Extensions"}
    >
      {/* Section headings carry no description (`settingsLayout.tsx`); what a
          reader needs to know goes next to the thing it explains. */}
      {group.rows.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          No extensions are installed on this server. Point it at a built extension folder to add
          one.
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
        >
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
            No server is connected. Connect to one to see the extensions installed on it.
          </p>
        </SettingsSection>
      ) : (
        groups.map((group) => (
          <ExtensionGroup group={group} key={group.environmentId} showLabel={showLabel} />
        ))
      )}
    </SettingsPageContainer>
  );
}
