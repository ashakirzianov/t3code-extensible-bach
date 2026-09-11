import {
  extensionDeployConfirmation,
  extensionRemoveConfirmation,
  type ExtensionSettingsRow,
} from "@t3tools/client-runtime/extensions";
import { getFilesystemBrowsePath } from "@t3tools/client-runtime/state/filesystem";
import { isExplicitRelativeProjectPath } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

/**
 * What the Extensions screen's two actions actually do, kept out of the markup
 * so the ordering can be tested.
 *
 * Both actions replace or stop a running process, so both have the same shape:
 * ask, act, and say what happened. The interesting part is the branches — a
 * declined confirmation must not dispatch, an interrupted command must not
 * raise an error at someone, and a failure has to name the extension, because
 * the screen shows several at once.
 */

export type ExtensionActionOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "done" }
  | { readonly status: "failed"; readonly title: string; readonly description: string };

/** Matches `requestConfirmDialog`: `undefined` when no themed host is mounted. */
export type ConfirmFn = (message: string) => Promise<boolean> | undefined;

const settle = <A, E>(
  result: AtomCommandResult<A, E>,
  title: string,
  fallback: string,
): ExtensionActionOutcome => {
  if (result._tag !== "Failure") return { status: "done" };
  // An interrupted command is a newer command taking over, not a failure
  // anyone needs to read about.
  if (isAtomCommandInterrupted(result)) return { status: "cancelled" };
  const error = squashAtomCommandFailure(result);
  const description =
    error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
  return { status: "failed", title, description };
};

/**
 * Deploy is stop, rehash, start, and it is human-only by design — nothing an
 * extension or an agent can call reaches it. The confirmation is therefore not
 * decoration: it is the only gate. A host with no confirm dialog mounted must
 * not silently deploy, so an absent one counts as declined.
 */
export async function confirmAndDeployExtension(input: {
  readonly row: ExtensionSettingsRow;
  readonly confirm: ConfirmFn;
  readonly deploy: (input: {
    readonly environmentId: ExtensionSettingsRow["environmentId"];
    readonly input: { readonly name: string };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<ExtensionActionOutcome> {
  const confirmation = input.confirm(extensionDeployConfirmation(input.row));
  if (confirmation === undefined) return { status: "cancelled" };
  if (!(await confirmation)) return { status: "cancelled" };
  const result = await input.deploy({
    environmentId: input.row.environmentId,
    input: { name: input.row.name },
  });
  return settle(
    result,
    `Could not deploy ${input.row.name}`,
    `Deploying ${input.row.name} failed.`,
  );
}

/**
 * Enable and disable are each other's reverse, so they are one call with a
 * flag rather than two paths that can drift. Disabling stops a running
 * process, so it asks; enabling only starts one, so it does not.
 */
export async function toggleExtensionEnabled(input: {
  readonly row: ExtensionSettingsRow;
  readonly nextEnabled: boolean;
  readonly confirm: ConfirmFn;
  readonly setEnabled: (input: {
    readonly environmentId: ExtensionSettingsRow["environmentId"];
    readonly input: { readonly name: string; readonly enabled: boolean };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<ExtensionActionOutcome> {
  if (!input.nextEnabled) {
    const confirmation = input.confirm(
      `Disable ${input.row.name}?\nIt stops now, and stays out until you enable it again.`,
    );
    if (confirmation === undefined) return { status: "cancelled" };
    if (!(await confirmation)) return { status: "cancelled" };
  }
  const result = await input.setEnabled({
    environmentId: input.row.environmentId,
    input: { name: input.row.name, enabled: input.nextEnabled },
  });
  const verb = input.nextEnabled ? "enable" : "disable";
  return settle(
    result,
    `Could not ${verb} ${input.row.name}`,
    `Failed to ${verb} ${input.row.name}.`,
  );
}

/**
 * Removing stops the extension, drops its settings entry and unregisters it.
 *
 * The data directory is a second, explicit question rather than part of the
 * first: removing to reinstall is the common case, and a single "are you sure"
 * that quietly also deleted state would make it lossy. Like Deploy, an absent
 * confirm host counts as declined.
 */
export async function confirmAndRemoveExtension(input: {
  readonly row: ExtensionSettingsRow;
  readonly deleteData: boolean;
  readonly confirm: ConfirmFn;
  readonly remove: (input: {
    readonly environmentId: ExtensionSettingsRow["environmentId"];
    readonly input: { readonly name: string; readonly deleteData: boolean };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<ExtensionActionOutcome> {
  const confirmation = input.confirm(
    extensionRemoveConfirmation({ row: input.row, deleteData: input.deleteData }),
  );
  if (confirmation === undefined) return { status: "cancelled" };
  if (!(await confirmation)) return { status: "cancelled" };
  const result = await input.remove({
    environmentId: input.row.environmentId,
    input: { name: input.row.name, deleteData: input.deleteData },
  });
  return settle(result, `Could not remove ${input.row.name}`, `Removing ${input.row.name} failed.`);
}

/**
 * Installing takes a path and gets a name back: the manifest names the
 * extension, so the form cannot ask for one and the answer is what to show.
 */
export async function installExtension(input: {
  readonly environmentId: ExtensionSettingsRow["environmentId"];
  readonly path: string;
  readonly install: (input: {
    readonly environmentId: ExtensionSettingsRow["environmentId"];
    readonly input: { readonly path: string };
  }) => Promise<AtomCommandResult<{ readonly name: string }, unknown>>;
}): Promise<ExtensionActionOutcome> {
  const path = input.path.trim();
  if (path.length === 0) {
    return {
      status: "failed",
      title: "No folder",
      description: "Enter the path to a built extension folder.",
    };
  }
  const result = await input.install({ environmentId: input.environmentId, input: { path } });
  return settle(result, "Could not add the extension", `Adding ${path} failed.`);
}

/**
 * The platform string the browse helpers expect, from the environment's
 * reported OS — the same mapping the Add project palette uses, because the
 * folder is on that server and its path rules are the server's, not this
 * device's. Falls back to the local platform when the server has not said.
 */
export function extensionBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

/**
 * What the Add extension typeahead asks the server to list for the text typed
 * so far, or `null` when there is nothing to ask.
 *
 * Browsing is server-side (`filesystem.browse`), so it lists the folders on the
 * machine the extension will actually run on, local or remote. A relative path
 * gets no suggestions: the palette resolves those against the active project,
 * and Settings has none — the path can still be typed and submitted, and the
 * server resolves it against its own working directory.
 */
export function extensionFolderBrowseRequest(
  query: string,
  platform: string,
): { readonly partialPath: string; readonly filterQuery: string } | null {
  if (isExplicitRelativeProjectPath(query.trim())) return null;
  const browse = getFilesystemBrowsePath(query, platform);
  if (!browse.isBrowsing || browse.directoryPath.length === 0) return null;
  return { partialPath: browse.directoryPath, filterQuery: browse.filterQuery };
}

/**
 * Whether the native folder dialog may be offered for this environment.
 *
 * Only when it would browse the right filesystem: the desktop app's own
 * primary backend, or a desktop-local secondary (today WSL) whose pool instance
 * id is known — without that id the dialog cannot be routed and would open the
 * primary's filesystem, then install that path against the wrong server. Never
 * in a plain browser, and never for a remote environment: its folder is on
 * another machine, which is what the server-side typeahead is for.
 */
export function canPickExtensionFolderNatively(input: {
  readonly environmentId: string;
  readonly primaryEnvironmentId: string | null;
  readonly isDesktopLocal: boolean;
  readonly desktopInstanceId: string | null;
  readonly hasDesktopBridge: boolean;
}): boolean {
  if (!input.hasDesktopBridge) return false;
  if (input.environmentId === input.primaryEnvironmentId) return true;
  return input.isDesktopLocal && input.desktopInstanceId !== null;
}
