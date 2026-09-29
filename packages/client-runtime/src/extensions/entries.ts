import type {
  EnvironmentId,
  ExtensionBadge,
  ExtensionListResult,
  ExtensionName,
  ExtensionRuntimeState,
  ExtensionStatus,
  ExtensionWebEntry,
} from "@t3tools/contracts";

/**
 * Turning one environment's extension list into the rows the host's nav draws.
 *
 * Kept as pure functions over the list the server already sends, so the sidebar,
 * the route, and (later) mobile all derive the same rows from the same input,
 * and so the derivation can be tested without a socket or a renderer.
 */

/**
 * One nav row: a (environment, extension) pair that has a web entry to mount.
 *
 * `environmentLabel` is only filled in when more than one environment is
 * connected — a single-environment client would just repeat the same word on
 * every row — and never on the primary environment's rows: those are the
 * unmarked default, and the label is what sets a remote row apart. (An SSH
 * environment on the same machine carries the same machine name, so labelling
 * both rows would label neither.)
 */
export interface ExtensionNavEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly name: ExtensionName;
  readonly label: string;
  readonly web: ExtensionWebEntry;
  readonly state: ExtensionRuntimeState;
  /** Absent, `none` and zero-count badges are normalised away, so a row either has one or does not. */
  readonly badge: ExtensionNavBadge | null;
  /** The folder moved under a running process: offer Deploy. */
  readonly changed: boolean;
  /** Nothing will mount until it is running; the route says so rather than spinning. */
  readonly available: boolean;
  readonly lastError: string | null;
}

export interface ExtensionEnvironmentList {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** The client's own backend (the desktop's local environment), not a remote one. */
  readonly primary?: boolean;
  readonly extensions: ReadonlyArray<ExtensionStatus>;
}

/** A badge that is actually drawn: `none` is normalised to `null` instead. */
export type ExtensionNavBadge = Exclude<ExtensionBadge, { readonly kind: "none" }>;

const normaliseBadge = (badge: ExtensionBadge | undefined): ExtensionNavBadge | null => {
  if (badge === undefined || badge.kind === "none") return null;
  // A zero count is a cleared badge that an extension expressed by counting
  // rather than by clearing. Drawing an empty circle for it would be noise.
  if (badge.kind === "count" && badge.count === 0) return null;
  return badge;
};

const toNavEntry = (
  status: ExtensionStatus,
  environmentId: EnvironmentId,
  environmentLabel: string | null,
): ExtensionNavEntry | null => {
  const web = status.web;
  if (web === undefined) return null;
  return {
    environmentId,
    environmentLabel,
    name: status.name,
    label: web.label,
    web,
    state: status.state,
    badge: normaliseBadge(status.badge),
    changed: status.changed,
    available: status.state === "running",
    lastError: status.lastError ?? null,
  };
};

/**
 * Every nav row across every connected environment, in the order the host
 * started the extensions — which is the order the environments were given and,
 * within one, the order the server lists them. Stable ordering matters more than
 * alphabetical: a row that moves when a badge changes is a row people misclick.
 */
export function extensionNavEntries(
  lists: ReadonlyArray<ExtensionEnvironmentList>,
): ReadonlyArray<ExtensionNavEntry> {
  const showEnvironment = lists.length > 1;
  const entries: ExtensionNavEntry[] = [];
  for (const list of lists) {
    for (const status of list.extensions) {
      const entry = toNavEntry(
        status,
        list.environmentId,
        showEnvironment && list.primary !== true ? list.environmentLabel : null,
      );
      if (entry !== null) entries.push(entry);
    }
  }
  return entries;
}

/** The row the extension route renders, or `null` when the URL names no known row. */
export function findExtensionNavEntry(
  entries: ReadonlyArray<ExtensionNavEntry>,
  target: { readonly environmentId: string; readonly name: string },
): ExtensionNavEntry | null {
  return (
    entries.find(
      (entry) => entry.environmentId === target.environmentId && entry.name === target.name,
    ) ?? null
  );
}

/**
 * What the route shows when it cannot mount. Phrased for the person looking at
 * it: the extension's own words when it has any, and otherwise what the state
 * means. `crashed` deliberately does not promise a retry — the supervisor may or
 * may not be restarting, and the log is where that question is answered.
 */
export function extensionUnavailableMessage(entry: ExtensionNavEntry): string | null {
  if (entry.available) return null;
  const detail = entry.lastError === null ? "" : ` ${entry.lastError}`;
  switch (entry.state) {
    case "disabled":
      return `${entry.label} is turned off. Enable it in Settings to use it.`;
    case "stopped":
      return `${entry.label} is not running.${detail}`;
    case "starting":
      return `${entry.label} is starting.`;
    case "crashed":
      return `${entry.label} stopped unexpectedly.${detail}`;
    case "running":
      return null;
  }
}

/** Total across every row, for a single indicator on a collapsed nav. */
export function extensionBadgeTotal(entries: ReadonlyArray<ExtensionNavEntry>): {
  readonly count: number;
  readonly dot: boolean;
} {
  let count = 0;
  let dot = false;
  for (const entry of entries) {
    if (entry.badge === null) continue;
    if (entry.badge.kind === "count") count += entry.badge.count;
    else dot = true;
  }
  return { count, dot };
}

/** Convenience for the common single-environment call. */
export function extensionListToNavEntries(
  environmentId: EnvironmentId,
  environmentLabel: string,
  list: ExtensionListResult,
): ReadonlyArray<ExtensionNavEntry> {
  return extensionNavEntries([{ environmentId, environmentLabel, extensions: list.extensions }]);
}
