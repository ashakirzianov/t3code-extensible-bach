/**
 * `extensions.generateText`: the environment's configured Text generation
 * model, asked one question on an extension's behalf.
 *
 * Two things the host owes the caller and the user, and they are the whole
 * module:
 *
 * - **A refusal rather than a surprise model.** The settings service already
 *   falls back to any enabled provider when the chosen one is gone
 *   (`resolveTextGenerationProvider`), so a selection that is *still* not
 *   enabled after that means the environment has no provider at all. Running it
 *   anyway would fail deep inside a driver with a message about an instance id.
 * - **No checkout.** Free-form generation has nothing to do with a project, and
 *   a CLI started in one reads that repository's agent configuration. The run
 *   gets an empty scratch directory that is removed with the request.
 */
import {
  ExtensionTextGenerationFailedError,
  ExtensionTextGenerationUnavailableError,
  type ExtensionGenerateTextInput,
  type ExtensionGenerateTextResult,
  type ServerSettings,
} from "@t3tools/contracts";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import type * as TextGeneration from "../textGeneration/TextGeneration.ts";

/** Matches `ExtensionTextGenerationFailedError.detail`'s bound. */
const DETAIL_MAX_CHARS = 1024;

export const generateExtensionText = Effect.fn("ExtensionTextGeneration.generateText")(
  function* (input: {
    readonly request: ExtensionGenerateTextInput;
    readonly settings: ServerSettings;
    readonly textGeneration: TextGeneration.TextGeneration["Service"];
    readonly fileSystem: FileSystem.FileSystem;
  }): Effect.fn.Return<
    ExtensionGenerateTextResult,
    ExtensionTextGenerationUnavailableError | ExtensionTextGenerationFailedError
  > {
    const modelSelection = input.settings.textGenerationModelSelection;
    if (!isModelSelectionProviderEnabled(input.settings, modelSelection)) {
      return yield* new ExtensionTextGenerationUnavailableError();
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* input.fileSystem
          .makeTempDirectoryScoped({ prefix: "t3code-extension-text-" })
          .pipe(
            Effect.mapError(
              () =>
                new ExtensionTextGenerationFailedError({
                  detail: "Could not create a working directory for the request.",
                }),
            ),
          );
        const generated = yield* input.textGeneration
          .generateText({
            cwd,
            prompt: input.request.prompt,
            ...(input.request.system === undefined ? {} : { system: input.request.system }),
            modelSelection,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ExtensionTextGenerationFailedError({
                  detail: error.detail.slice(0, DETAIL_MAX_CHARS),
                }),
            ),
          );
        return { text: generated.text };
      }),
    );
  },
);
