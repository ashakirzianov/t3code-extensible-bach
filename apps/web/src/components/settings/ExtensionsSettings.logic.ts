import {
  extensionDeployConfirmation,
  type ExtensionSettingsRow,
} from "@t3tools/client-runtime/extensions";
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
