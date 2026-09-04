import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as FatalStartup from "@t3tools/shared/fatalStartup";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendSnapshot, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

function makeStubInstance(
  id: DesktopBackendPool.BackendInstanceId,
  label: string,
): DesktopBackendPool.DesktopBackendInstance {
  const snapshot: DesktopBackendSnapshot = {
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  };
  return {
    id,
    label: Effect.succeed(label),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

// Most tests here only assert registry composition, so every moving part
// below dies by default; a test that wants a real backend run overrides just
// the pieces it needs.
interface PoolLayerOverrides {
  readonly spawner?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
  readonly fileSystem?: Layer.Layer<FileSystem.FileSystem>;
  readonly resolvePrimary?: DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]["resolvePrimary"];
}

function makePoolLayer(
  labelRef: Ref.Ref<string>,
  overrides: PoolLayerOverrides = {},
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        overrides.fileSystem ?? FileSystem.layerNoop({}),
        overrides.spawner ??
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
          ),
        overrides.httpClient ??
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected HTTP request")),
          ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => Effect.void,
              discardSession: Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeed(Option.none()),
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControl: () => Effect.void,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary:
            overrides.resolvePrimary ?? Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopWslEnvironment.layerTest(),
        ElectronDialog.layer,
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected window create"),
          ensureMain: Effect.die("unexpected window ensure"),
          revealOrCreateMain: Effect.die("unexpected window reveal"),
          activate: Effect.die("unexpected window activate"),
          createMainIfBackendReady: Effect.die("unexpected window create"),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          dispatchMenuAction: () => Effect.die("unexpected menu action"),
          zoomMain: () => Effect.die("unexpected zoom"),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

describe("DesktopBackendPool", () => {
  it.effect("layerTest exposes registered instances by id", () =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const fetchedPrimary = yield* pool.get(DesktopBackendPool.PRIMARY_INSTANCE_ID);
      const fetchedWsl = yield* pool.get(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"));
      const fetchedMissing = yield* pool.get(DesktopBackendPool.BackendInstanceId("missing"));
      const all = yield* pool.list;
      const resolvedPrimary = yield* pool.primary;

      assert.equal(yield* Option.getOrThrow(fetchedPrimary).label, "Windows");
      assert.equal(yield* Option.getOrThrow(fetchedWsl).label, "WSL (Ubuntu)");
      assert.isTrue(Option.isNone(fetchedMissing));
      assert.lengthOf(all, 2);
      // First instance becomes primary in layerTest so single-instance
      // stubs don't have to wire an explicit primary.
      assert.equal(resolvedPrimary.id, DesktopBackendPool.PRIMARY_INSTANCE_ID);
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          makeStubInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, "Windows"),
          makeStubInstance(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"), "WSL (Ubuntu)"),
        ]),
      ),
    ),
  );

  it.effect("layerTest dies when no instances are supplied", () =>
    Effect.exit(
      Effect.gen(function* () {
        yield* DesktopBackendPool.DesktopBackendPool;
      }).pipe(Effect.provide(DesktopBackendPool.layerTest([]))),
    ).pipe(Effect.map((exit) => assert.equal(exit._tag, "Failure"))),
  );

  it.effect("resolves the primary label lazily after pool layer construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labelRef = yield* Ref.make("Windows");
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(makePoolLayer(labelRef)),
        );
        const primary = yield* pool.primary;

        yield* Ref.set(labelRef, "WSL (Ubuntu)");

        assert.equal(yield* primary.label, "WSL (Ubuntu)");
      }),
    ),
  );

  it.effect("reports a primary backend that refuses to start", () => {
    const failure = {
      tag: "DatabaseMigratedAheadError",
      message: "This T3 Code build cannot open /tmp/t3/userdata: schema 49, this build knows 47.",
    };
    const primaryConfig: DesktopBackendStartConfig = {
      executablePath: "/electron",
      args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
      entryPath: "/server/bin.mjs",
      cwd: "/server",
      env: { ELECTRON_RUN_AS_NODE: "1" },
      bootstrap: {
        mode: "desktop",
        noBrowser: true,
        port: 3773,
        t3Home: "/tmp/t3",
        host: "127.0.0.1",
        desktopBootstrapToken: "token",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        desktopTelemetryFd: 4,
        desktopTelemetryControlFd: 5,
      },
      bootstrapDelivery: "fd3",
      extendEnv: true,
      httpBaseUrl: new URL("http://127.0.0.1:3773"),
      captureOutput: true,
      preflightFailure: Option.none(),
    };

    return Effect.gen(function* () {
      const labelRef = yield* Ref.make("Windows");
      return yield* Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const primary = yield* pool.primary;

        yield* primary.start;

        // The manager detects the marker; the pool's job is only to pass it
        // on, so this resolving is the whole assertion.
        assert.deepEqual(yield* pool.primaryFatalStartup, failure);
      }).pipe(
        Effect.provide(
          makePoolLayer(labelRef, {
            fileSystem: FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
            httpClient: Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
                ),
              ),
            ),
            resolvePrimary: Effect.succeed(primaryConfig),
            spawner: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.succeed(
                  ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(123),
                    stdout: Stream.empty,
                    stderr: Stream.make(
                      new TextEncoder().encode(`${FatalStartup.formatFatalStartupLine(failure)}\n`),
                    ),
                    all: Stream.empty,
                    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    stdin: Sink.drain,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void),
                  }),
                ),
              ),
            ),
          }),
        ),
      );
    });
  });
});
