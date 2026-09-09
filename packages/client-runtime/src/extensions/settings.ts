import type {
  EnvironmentId,
  ExtensionName,
  ExtensionRejection,
  ExtensionRuntimeState,
  ExtensionStatus,
} from "@t3tools/contracts";

import type { ExtensionEnvironmentList } from "./entries.ts";

/**
 * Turning one environment's extension list into the rows the Settings screen
 * renders.
 *
 * The screen's whole job is to answer three questions about an extension —
 * what is it, is it working, and what can I do about it — so the derivation
 * here answers them once, as data, rather than each being re-decided inline
 * next to the markup that shows it.
 */

/** How a state reads, and how much attention it deserves. */
export type ExtensionStateTone = "ok" | "pending" | "muted" | "problem";

export interface ExtensionStateView {
  readonly state: ExtensionRuntimeState;
  readonly label: string;
  readonly tone: ExtensionStateTone;
}

/**
 * One thing that is wrong, in the order a person would want to read them.
 * `lastError` first because it is why the process is not running; rejections
 * after, because they describe a running extension that is missing a piece.
 */
export interface ExtensionProblem {
  readonly kind: "error" | "tool" | "http-prefix";
  readonly subject: string | null;
  readonly message: string;
}

export interface ExtensionSettingsRow {
  readonly environmentId: EnvironmentId;
  readonly name: ExtensionName;
  readonly version: string | null;
  readonly path: string;
  /** "Settings entry" or "Launch flag" — which of the two sources named it. */
  readonly sourceLabel: string;
  readonly enabled: boolean;
  readonly stateView: ExtensionStateView;
  /** A newer build is on disk than the running process was started from. */
  readonly changed: boolean;
  readonly tools: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<ExtensionProblem>;
  readonly restartCount: number;
  readonly hasWebEntry: boolean;
  /**
   * Deploy is stop, rehash, start. Offering it on a disabled extension would
   * be a way to start something the user turned off, so it is gated on both
   * the flag and the switch.
   */
  readonly canDeploy: boolean;
  /** The anchor a deep link from the sidebar or a search result lands on. */
  readonly anchorId: string;
}

export interface ExtensionSettingsGroup {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly rows: ReadonlyArray<ExtensionSettingsRow>;
}

const STATE_VIEWS: Readonly<Record<ExtensionRuntimeState, Omit<ExtensionStateView, "state">>> = {
  running: { label: "Running", tone: "ok" },
  starting: { label: "Starting", tone: "pending" },
  stopped: { label: "Stopped", tone: "muted" },
  disabled: { label: "Disabled", tone: "muted" },
  crashed: { label: "Crashed", tone: "problem" },
};

const SOURCE_LABELS = {
  settings: "Settings entry",
  "launch-flag": "Launch flag",
} as const;

/**
 * The id a deep link targets. Both parts are needed: the same extension can be
 * installed on two connected environments, and each has its own row.
 */
export function extensionSettingsAnchorId(
  environmentId: EnvironmentId | string,
  name: ExtensionName | string,
): string {
  return `extension-${environmentId}-${name}`;
}

const toProblems = (status: ExtensionStatus): ReadonlyArray<ExtensionProblem> => {
  const problems: ExtensionProblem[] = [];
  if (status.lastError !== undefined) {
    problems.push({ kind: "error", subject: null, message: status.lastError });
  }
  for (const rejection of status.rejections as ReadonlyArray<ExtensionRejection>) {
    problems.push({
      kind: rejection.kind,
      subject: rejection.subject,
      message: rejection.message,
    });
  }
  return problems;
};

export function extensionSettingsRow(
  environmentId: EnvironmentId,
  status: ExtensionStatus,
): ExtensionSettingsRow {
  return {
    environmentId,
    name: status.name,
    version: status.version ?? null,
    path: status.path,
    sourceLabel: SOURCE_LABELS[status.source],
    enabled: status.enabled,
    stateView: { state: status.state, ...STATE_VIEWS[status.state] },
    changed: status.changed,
    tools: [...status.tools],
    problems: toProblems(status),
    restartCount: status.restartCount,
    hasWebEntry: status.web !== undefined,
    canDeploy: status.changed && status.enabled,
    anchorId: extensionSettingsAnchorId(environmentId, status.name),
  };
}

/**
 * Every row, grouped by environment and in the order the host installed them —
 * which is also the order that settles tool-name collisions, so a reader
 * comparing two rows sees the winner first.
 */
export function extensionSettingsGroups(
  lists: ReadonlyArray<ExtensionEnvironmentList>,
): ReadonlyArray<ExtensionSettingsGroup> {
  return lists.map((list) => ({
    environmentId: list.environmentId,
    environmentLabel: list.environmentLabel,
    rows: list.extensions.map((status) => extensionSettingsRow(list.environmentId, status)),
  }));
}

/** What the Enable/Disable control says and does next. Every action has its opposite. */
export function extensionToggleAction(row: ExtensionSettingsRow): {
  readonly label: string;
  readonly nextEnabled: boolean;
  readonly description: string;
} {
  return row.enabled
    ? {
        label: "Disable",
        nextEnabled: false,
        description: "Stops the extension and leaves it out of the next start.",
      }
    : {
        label: "Enable",
        nextEnabled: true,
        description: "Starts the extension and includes it in every start from now on.",
      };
}

/**
 * The confirmation Deploy asks for. Host-owned and human-only by design: no
 * extension and no agent can reach Deploy, so the words here are the last
 * checkpoint before a running process is replaced.
 */
export function extensionDeployConfirmation(row: ExtensionSettingsRow): string {
  return `Deploy the new build of ${row.name}?\nIt stops and starts again on the build that is on disk now.`;
}

export function extensionRemoveConfirmation(input: {
  readonly row: ExtensionSettingsRow;
  readonly deleteData: boolean;
}): string {
  const base = `Remove ${input.row.name}?\nIt stops now and is no longer installed on this server.`;
  return input.deleteData
    ? `${base} Its data directory is deleted too, and that cannot be undone.`
    : `${base} Its data directory is kept.`;
}

/** True when nothing is installed anywhere, which is its own empty state. */
export function extensionSettingsIsEmpty(groups: ReadonlyArray<ExtensionSettingsGroup>): boolean {
  return groups.every((group) => group.rows.length === 0);
}
