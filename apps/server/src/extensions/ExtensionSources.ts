/**
 * Where the host learns which extensions to run.
 *
 * Two sources, and no third (design §6.2): entries in the environment's
 * settings, and repeatable `--extension name=path` launch flags. The word
 * "bundled" appears nowhere — the desktop shell passes a launch flag for
 * whatever sits in its resources directory, which makes a shipped extension
 * indistinguishable from one a developer pointed at by hand.
 *
 * **Settings win by name.** Writing an entry for `bach` pointing at a local
 * build overrides the shipped one; writing one with `enabled: false` turns it
 * off. That single rule is what makes the launch flag safe to hardcode in the
 * desktop build.
 */
import type { ExtensionName, ExtensionSettingsEntry, ExtensionSource } from "@t3tools/contracts";
import { ExtensionName as ExtensionNameSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ResolvedExtensionSource {
  readonly name: ExtensionName;
  /** Absolute, or relative to the server's cwd. Resolved by the caller. */
  readonly path: string;
  readonly enabled: boolean;
  readonly source: ExtensionSource;
}

export interface ExtensionLaunchFlag {
  readonly name: ExtensionName;
  readonly path: string;
}

const isExtensionName = Schema.is(ExtensionNameSchema);

/**
 * Turn the CLI's parsed `--extension name=path` record into launch flags.
 *
 * Entries with a name that is not an extension identifier, or with an empty
 * path, are dropped rather than failing startup: a typo in a flag must not
 * stop the server the user is trying to reach.
 */
export const extensionLaunchFlagsFromRecord = (
  record: Readonly<Record<string, string>>,
): ReadonlyArray<ExtensionLaunchFlag> =>
  Object.entries(record).flatMap(([name, path]) => {
    const trimmedPath = path.trim();
    return trimmedPath === "" || !isExtensionName(name) ? [] : [{ name, path: trimmedPath }];
  });

/**
 * Merge both sources into the list the registry starts, in a deterministic
 * order: settings entries first in the order they are written, then launch
 * flags the settings did not name. Order is load-bearing — design §5.2 settles
 * a tool-name collision by whoever started first, so it has to be stable
 * across restarts and not depend on a map's iteration order.
 */
export const resolveExtensionSources = (input: {
  readonly settingsEntries: ReadonlyArray<ExtensionSettingsEntry>;
  readonly launchFlags: ReadonlyArray<ExtensionLaunchFlag>;
}): ReadonlyArray<ResolvedExtensionSource> => {
  const resolved: ResolvedExtensionSource[] = [];
  const seen = new Set<string>();
  for (const entry of input.settingsEntries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    resolved.push({
      name: entry.name,
      path: entry.path,
      enabled: entry.enabled,
      source: "settings",
    });
  }
  for (const flag of input.launchFlags) {
    if (seen.has(flag.name)) continue;
    seen.add(flag.name);
    resolved.push({ name: flag.name, path: flag.path, enabled: true, source: "launch-flag" });
  }
  return resolved;
};
