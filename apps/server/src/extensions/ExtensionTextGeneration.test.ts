import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { generateExtensionText } from "./ExtensionTextGeneration.ts";

const stubTextGeneration = (
  generateText: TextGeneration.TextGeneration["Service"]["generateText"],
): TextGeneration.TextGeneration["Service"] => ({
  generateCommitMessage: () => Effect.die("not used"),
  generatePrContent: () => Effect.die("not used"),
  generateBranchName: () => Effect.die("not used"),
  generateThreadTitle: () => Effect.die("not used"),
  generateText,
});

/** The settings the service would hand the handler, defaults resolved. */
const settingsFor = (overrides: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  Effect.gen(function* () {
    const service = yield* ServerSettings.ServerSettingsService;
    return yield* service.getSettings;
  }).pipe(Effect.provide(ServerSettings.layerTest(overrides)), Effect.orDie);

const everyProviderDisabled = {
  providers: {
    codex: { enabled: false },
    claudeAgent: { enabled: false },
    cursor: { enabled: false },
    grok: { enabled: false },
    opencode: { enabled: false },
    antigravity: { enabled: false },
  },
} satisfies Parameters<typeof ServerSettings.layerTest>[0];

it.effect("answers with the configured model's text, in a directory of its own", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const settings = yield* settingsFor();
    const calls: Array<TextGeneration.TextGenerationInput> = [];

    const result = yield* generateExtensionText({
      request: { prompt: "Proofread this.", system: "You are a proofreader." },
      settings,
      fileSystem,
      textGeneration: stubTextGeneration((input) => {
        calls.push(input);
        return Effect.succeed({ text: "Two spelling fixes." });
      }),
    });

    expect(result.text).toBe("Two spelling fixes.");
    const call = calls[0];
    expect(call?.prompt).toBe("Proofread this.");
    expect(call?.system).toBe("You are a proofreader.");
    // Never the server's own checkout: a CLI started there reads that
    // repository's agent configuration into an unrelated answer.
    expect(call?.cwd).not.toBe(process.cwd());
    expect(call?.modelSelection.instanceId).toBe(ProviderInstanceId.make("codex"));
    // The scratch directory belongs to the request and does not outlive it.
    expect(yield* fileSystem.exists(call?.cwd ?? ".").pipe(Effect.orDie)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses when the environment has no text generation provider", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const settings = yield* settingsFor(everyProviderDisabled);

    const error = yield* Effect.flip(
      generateExtensionText({
        request: { prompt: "Proofread this." },
        settings,
        fileSystem,
        textGeneration: stubTextGeneration(() => Effect.die("must not reach a provider")),
      }),
    );

    expect(error._tag).toBe("ExtensionTextGenerationUnavailableError");
    expect(error.message).toContain("No text generation provider is configured");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a provider failure as the extension-facing error", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const settings = yield* settingsFor();

    const error = yield* Effect.flip(
      generateExtensionText({
        request: { prompt: "Proofread this." },
        settings,
        fileSystem,
        textGeneration: stubTextGeneration(() =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateText",
              detail: "Codex CLI command failed: not signed in.",
            }),
          ),
        ),
      }),
    );

    expect(error._tag).toBe("ExtensionTextGenerationFailedError");
    expect(error.message).toContain("not signed in");
  }).pipe(Effect.provide(NodeServices.layer)),
);
