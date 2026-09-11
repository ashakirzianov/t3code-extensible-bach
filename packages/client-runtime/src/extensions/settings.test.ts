import type { EnvironmentId, ExtensionStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  extensionChangePathConfirmation,
  extensionDeployConfirmation,
  extensionSettingsAnchorId,
  extensionSettingsGroups,
  extensionSettingsIsEmpty,
  extensionToggleAction,
} from "./settings.ts";

const environmentId = (value: string) => value as EnvironmentId;

const status = (overrides: Partial<ExtensionStatus> & { name: string }): ExtensionStatus =>
  ({
    path: `/extensions/${overrides.name}`,
    source: "settings",
    enabled: true,
    state: "running",
    changed: false,
    tools: [],
    rejections: [],
    restartCount: 0,
    ...overrides,
  }) as ExtensionStatus;

const groupsOf = (...extensions: ReadonlyArray<ExtensionStatus>) =>
  extensionSettingsGroups([
    { environmentId: environmentId("env-1"), environmentLabel: "Laptop", extensions },
  ]);

describe("extension settings rows", () => {
  it("keeps every extension, not only the ones with a web entry", () => {
    const [group] = groupsOf(
      status({ name: "bach", web: { entry: "web/entry.js", label: "Bach" } }),
      status({ name: "headless" }),
    );

    expect(group?.rows.map((row) => row.name)).toEqual(["bach", "headless"]);
    expect(group?.rows.map((row) => row.hasWebEntry)).toEqual([true, false]);
  });

  it("names the source, the version and the state in the words the screen shows", () => {
    const [group] = groupsOf(
      status({ name: "bach", version: "1.2.0", source: "launch-flag", state: "crashed" }),
      status({ name: "notes", state: "starting" }),
    );

    expect(group?.rows[0]).toMatchObject({
      version: "1.2.0",
      sourceLabel: "Launch flag",
      stateView: { state: "crashed", label: "Crashed", tone: "problem" },
    });
    expect(group?.rows[1]).toMatchObject({
      version: null,
      sourceLabel: "Settings entry",
      stateView: { state: "starting", label: "Starting", tone: "pending" },
    });
  });

  it("offers Deploy only for a changed extension that is still enabled", () => {
    const [group] = groupsOf(
      status({ name: "unchanged" }),
      status({ name: "changed", changed: true }),
      status({ name: "off", changed: true, enabled: false, state: "disabled" }),
    );

    expect(group?.rows.map((row) => row.canDeploy)).toEqual([false, true, false]);
  });

  it("puts the failure reason ahead of the refusals, and keeps both", () => {
    const [group] = groupsOf(
      status({
        name: "bach",
        state: "crashed",
        lastError: "exited with code 1",
        rejections: [
          {
            kind: "tool",
            subject: "spawn_agent",
            message: "Tool spawn_agent is already provided by extension notes.",
          },
          {
            kind: "http-prefix",
            subject: "api",
            message: "HTTP prefix api is reserved by T3 Code.",
          },
        ],
      }),
    );

    expect(group?.rows[0]?.problems).toEqual([
      { kind: "error", subject: null, message: "exited with code 1" },
      {
        kind: "tool",
        subject: "spawn_agent",
        message: "Tool spawn_agent is already provided by extension notes.",
      },
      { kind: "http-prefix", subject: "api", message: "HTTP prefix api is reserved by T3 Code." },
    ]);
  });

  it("gives each (environment, extension) its own anchor so a deep link is unambiguous", () => {
    const groups = extensionSettingsGroups([
      {
        environmentId: environmentId("env-1"),
        environmentLabel: "Laptop",
        extensions: [status({ name: "bach" })],
      },
      {
        environmentId: environmentId("env-2"),
        environmentLabel: "Desktop",
        extensions: [status({ name: "bach" })],
      },
    ]);

    const anchors = groups.flatMap((group) => group.rows.map((row) => row.anchorId));
    expect(anchors).toEqual(["extension-env-1-bach", "extension-env-2-bach"]);
    expect(extensionSettingsAnchorId("env-1", "bach")).toBe("extension-env-1-bach");
  });

  it("names the opposite of whatever the extension is doing now", () => {
    const [group] = groupsOf(status({ name: "on" }), status({ name: "off", enabled: false }));

    expect(extensionToggleAction(group!.rows[0]!)).toMatchObject({
      label: "Disable",
      nextEnabled: false,
    });
    expect(extensionToggleAction(group!.rows[1]!)).toMatchObject({
      label: "Enable",
      nextEnabled: true,
    });
  });

  it("asks before replacing a running process, naming the extension", () => {
    const [group] = groupsOf(status({ name: "bach", changed: true }));
    const message = extensionDeployConfirmation(group!.rows[0]!);

    expect(message).toContain("bach");
    expect(message).toContain("?");
  });

  it("distinguishes no extensions anywhere from an environment with none", () => {
    expect(extensionSettingsIsEmpty(groupsOf())).toBe(true);
    expect(extensionSettingsIsEmpty(groupsOf(status({ name: "bach" })))).toBe(false);
  });
});

describe("repointing an extension", () => {
  it("asks before restarting it, naming the extension and the new folder", () => {
    const [group] = groupsOf(status({ name: "bach", source: "launch-flag" }));

    const message = extensionChangePathConfirmation(group!.rows[0]!, "/home/me/bach/dist");
    expect(message).toContain("bach");
    expect(message).toContain("/home/me/bach/dist");
  });
});

describe("removing an extension from Settings", () => {
  it("is offered only for what a settings entry installed", () => {
    const [group] = groupsOf(
      status({ name: "mine", source: "settings" }),
      status({ name: "shipped", source: "launch-flag" }),
    );
    expect(group?.rows.map((row) => row.canRemove)).toEqual([true, false]);
  });
});
