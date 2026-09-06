import type { ExtensionSettingsRow } from "@t3tools/client-runtime/extensions";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { confirmAndDeployExtension, toggleExtensionEnabled } from "./ExtensionsSettings.logic";

const row = (overrides: Partial<ExtensionSettingsRow> = {}): ExtensionSettingsRow =>
  ({
    environmentId: "env-1",
    name: "bach",
    version: "1.0.0",
    path: "/opt/bach",
    sourceLabel: "Settings entry",
    enabled: true,
    stateView: { state: "running", label: "Running", tone: "ok" },
    changed: true,
    tools: [],
    problems: [],
    restartCount: 0,
    hasWebEntry: true,
    canDeploy: true,
    anchorId: "extension-env-1-bach",
    ...overrides,
  }) as ExtensionSettingsRow;

const succeeded = AsyncResult.success(undefined) as AtomCommandResult<unknown, unknown>;
const failed = AsyncResult.failure(
  Cause.fail(new Error("the folder disappeared")),
) as AtomCommandResult<unknown, unknown>;
const interrupted = AsyncResult.failure(Cause.interrupt(1)) as AtomCommandResult<unknown, unknown>;

const recorder = () => {
  const calls: unknown[] = [];
  return {
    calls,
    of: (result: AtomCommandResult<unknown, unknown>) => async (input: unknown) => {
      calls.push(input);
      return result;
    },
  };
};

describe("deploying an extension from Settings", () => {
  it("dispatches only after the confirmation is accepted", async () => {
    const deploy = recorder();
    const outcome = await confirmAndDeployExtension({
      row: row(),
      confirm: () => Promise.resolve(true),
      deploy: deploy.of(succeeded),
    });

    expect(outcome).toEqual({ status: "done" });
    expect(deploy.calls).toEqual([{ environmentId: "env-1", input: { name: "bach" } }]);
  });

  it("does not dispatch when the confirmation is declined", async () => {
    const deploy = recorder();
    const outcome = await confirmAndDeployExtension({
      row: row(),
      confirm: () => Promise.resolve(false),
      deploy: deploy.of(succeeded),
    });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(deploy.calls).toEqual([]);
  });

  it("treats a host with no confirmation dialog as a decline, never as consent", async () => {
    const deploy = recorder();
    const outcome = await confirmAndDeployExtension({
      row: row(),
      confirm: () => undefined,
      deploy: deploy.of(succeeded),
    });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(deploy.calls).toEqual([]);
  });

  it("names the extension and the reason when the deploy fails", async () => {
    const outcome = await confirmAndDeployExtension({
      row: row(),
      confirm: () => Promise.resolve(true),
      deploy: recorder().of(failed),
    });

    expect(outcome).toEqual({
      status: "failed",
      title: "Could not deploy bach",
      description: "the folder disappeared",
    });
  });

  it("stays quiet when a newer command interrupted this one", async () => {
    const outcome = await confirmAndDeployExtension({
      row: row(),
      confirm: () => Promise.resolve(true),
      deploy: recorder().of(interrupted),
    });

    expect(outcome).toEqual({ status: "cancelled" });
  });
});

describe("enabling and disabling an extension from Settings", () => {
  it("enables without asking, because nothing is being stopped", async () => {
    const setEnabled = recorder();
    let asked = false;
    const outcome = await toggleExtensionEnabled({
      row: row({ enabled: false }),
      nextEnabled: true,
      confirm: () => {
        asked = true;
        return Promise.resolve(true);
      },
      setEnabled: setEnabled.of(succeeded),
    });

    expect(asked).toBe(false);
    expect(outcome).toEqual({ status: "done" });
    expect(setEnabled.calls).toEqual([
      { environmentId: "env-1", input: { name: "bach", enabled: true } },
    ]);
  });

  it("asks before disabling, and sends the flag the user agreed to", async () => {
    const setEnabled = recorder();
    const messages: string[] = [];
    const outcome = await toggleExtensionEnabled({
      row: row(),
      nextEnabled: false,
      confirm: (message) => {
        messages.push(message);
        return Promise.resolve(true);
      },
      setEnabled: setEnabled.of(succeeded),
    });

    expect(messages[0]).toContain("bach");
    expect(outcome).toEqual({ status: "done" });
    expect(setEnabled.calls).toEqual([
      { environmentId: "env-1", input: { name: "bach", enabled: false } },
    ]);
  });

  it("leaves a running extension alone when the disable is declined", async () => {
    const setEnabled = recorder();
    const outcome = await toggleExtensionEnabled({
      row: row(),
      nextEnabled: false,
      confirm: () => Promise.resolve(false),
      setEnabled: setEnabled.of(succeeded),
    });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(setEnabled.calls).toEqual([]);
  });

  it("names the direction it failed in", async () => {
    const outcome = await toggleExtensionEnabled({
      row: row({ enabled: false }),
      nextEnabled: true,
      confirm: () => Promise.resolve(true),
      setEnabled: recorder().of(failed),
    });

    expect(outcome).toMatchObject({ status: "failed", title: "Could not enable bach" });
  });
});
