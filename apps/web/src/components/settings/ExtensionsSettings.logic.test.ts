import type { ExtensionSettingsRow } from "@t3tools/client-runtime/extensions";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  canPickExtensionFolderNatively,
  confirmAndChangeExtensionPath,
  confirmAndDeployExtension,
  extensionFolderBrowseRequest,
  toggleExtensionEnabled,
} from "./ExtensionsSettings.logic";

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

describe("the Add extension folder typeahead", () => {
  it("lists the typed directory and filters by the partial name after it", () => {
    expect(extensionFolderBrowseRequest("~/code/ext", "Linux")).toEqual({
      partialPath: "~/code/",
      filterQuery: "ext",
    });
    expect(extensionFolderBrowseRequest("/opt/extensions/", "Linux")).toEqual({
      partialPath: "/opt/extensions/",
      filterQuery: "",
    });
  });

  it("asks for nothing until the text is a path", () => {
    expect(extensionFolderBrowseRequest("", "Linux")).toBeNull();
    expect(extensionFolderBrowseRequest("dist", "Linux")).toBeNull();
  });

  it("offers no suggestions for a relative path, which Settings has no directory to resolve", () => {
    // The palette resolves these against the active project; Settings has none.
    // Submitting still works — the server resolves it against its own cwd.
    expect(extensionFolderBrowseRequest("./dist", "Linux")).toBeNull();
    expect(extensionFolderBrowseRequest("../reference/dist", "Linux")).toBeNull();
  });

  it("follows the server's path rules, not this device's", () => {
    // A Windows drive path only browses when the *server* is Windows.
    expect(extensionFolderBrowseRequest("C:\\Users\\", "Linux")).toBeNull();
    expect(extensionFolderBrowseRequest("C:\\Users\\", "Win32")).toEqual({
      partialPath: "C:\\Users\\",
      filterQuery: "",
    });
  });
});

describe("offering the native folder dialog", () => {
  const base = {
    environmentId: "env-1",
    primaryEnvironmentId: "env-1",
    isDesktopLocal: false,
    desktopInstanceId: null,
    hasDesktopBridge: true,
  };

  it("offers it for the desktop app's own server", () => {
    expect(canPickExtensionFolderNatively(base)).toBe(true);
  });

  it("never offers it in a plain browser, where there is no dialog to open", () => {
    expect(canPickExtensionFolderNatively({ ...base, hasDesktopBridge: false })).toBe(false);
  });

  it("never offers it for a remote server, whose folders are on another machine", () => {
    expect(canPickExtensionFolderNatively({ ...base, environmentId: "remote-env" })).toBe(false);
  });

  it("offers it for a desktop-local secondary only once its instance id is known", () => {
    const secondary = { ...base, environmentId: "wsl-env", isDesktopLocal: true };
    // Without the id the dialog cannot be routed and would browse the primary's
    // filesystem, then install that path against the wrong server.
    expect(canPickExtensionFolderNatively(secondary)).toBe(false);
    expect(canPickExtensionFolderNatively({ ...secondary, desktopInstanceId: "wsl:ubuntu" })).toBe(
      true,
    );
  });
});

describe("changing an installed extension's folder", () => {
  it("asks first, then sends the trimmed path under the extension's own name", async () => {
    const setPath = recorder();
    const asked: string[] = [];
    const outcome = await confirmAndChangeExtensionPath({
      row: row(),
      path: "  /home/me/bach/dist  ",
      confirm: (message) => {
        asked.push(message);
        return Promise.resolve(true);
      },
      setPath: setPath.of(succeeded),
    });

    expect(outcome).toEqual({ status: "done" });
    expect(asked[0]).toContain("/home/me/bach/dist");
    expect(setPath.calls).toEqual([
      { environmentId: "env-1", input: { name: "bach", path: "/home/me/bach/dist" } },
    ]);
  });

  it("leaves the running extension alone when the restart is declined", async () => {
    const setPath = recorder();
    const outcome = await confirmAndChangeExtensionPath({
      row: row(),
      path: "/home/me/bach/dist",
      confirm: () => Promise.resolve(false),
      setPath: setPath.of(succeeded),
    });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(setPath.calls).toEqual([]);
  });

  it("does not restart anything for the folder it already runs from", async () => {
    const setPath = recorder();
    let asked = false;
    const outcome = await confirmAndChangeExtensionPath({
      row: row({ path: "/opt/bach" }),
      path: "/opt/bach",
      confirm: () => {
        asked = true;
        return Promise.resolve(true);
      },
      setPath: setPath.of(succeeded),
    });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(asked).toBe(false);
    expect(setPath.calls).toEqual([]);
  });

  it("names the extension and the folder when the server refuses it", async () => {
    const outcome = await confirmAndChangeExtensionPath({
      row: row(),
      path: "/tmp/not-an-extension",
      confirm: () => Promise.resolve(true),
      setPath: recorder().of(failed),
    });

    expect(outcome).toMatchObject({ status: "failed", title: "Could not change bach's folder" });
  });
});
