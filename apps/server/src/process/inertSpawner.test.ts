import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as InertSpawner from "./inertSpawner.ts";

// The platform spawner under the gate, recording what reached it.
const recordingSpawner = (reached: Array<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        reached.push(ChildProcess.isStandardCommand(command) ? command.command : "piped");
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

const spawnThroughGate = (command: ChildProcess.Command, reached: Array<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.spawn(command).pipe(Effect.exit);
  }).pipe(
    Effect.scoped,
    Effect.provide(InertSpawner.layer.pipe(Layer.provide(recordingSpawner(reached)))),
  );

describe("inert spawner", () => {
  it.effect("lets an extension's node through and refuses git, gh and a provider CLI", () =>
    Effect.gen(function* () {
      const reached: Array<string> = [];
      const node = yield* spawnThroughGate(
        ChildProcess.make(process.execPath, ["server.mjs"]),
        reached,
      );
      expect(node._tag).toBe("Success");

      for (const refused of ["git", "gh", "claude", "codex", "cloudflared", "node"]) {
        const exit = yield* spawnThroughGate(ChildProcess.make(refused, ["--version"]), reached);
        expect(exit._tag).toBe("Failure");
      }
      expect(reached).toEqual([process.execPath]);
    }),
  );

  it("allows exactly this Node binary, by path", () => {
    expect(InertSpawner.inertAllows(ChildProcess.make("/usr/bin/node", []), "/opt/node")).toBe(
      false,
    );
    expect(InertSpawner.inertAllows(ChildProcess.make("/opt/node", ["x"]), "/opt/node")).toBe(true);
  });
});
