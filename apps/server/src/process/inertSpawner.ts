import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * Whether an inert server (`ServerConfig.inert`) may run a command: only this
 * Node binary itself, which is how extensions are started. Everything else —
 * git, `gh`, a provider CLI, cloudflared, a setup script — is a way for a copy
 * of someone's live state to act on their real workspaces.
 */
export const inertAllows = (
  command: ChildProcess.Command,
  execPath: string = process.execPath,
): boolean => ChildProcess.isStandardCommand(command) && command.command === execPath;

const describeCommand = (command: ChildProcess.Command): string =>
  ChildProcess.isStandardCommand(command) ? command.command : "a piped command";

/**
 * The spawner for an inert server: the real one for an extension's `node`,
 * a refusal for anything else. Sits over the platform spawner, so every
 * process the server's services start passes through it.
 */
export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) =>
      inertAllows(command)
        ? real.spawn(command)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
              description: `inert server: refused to run ${describeCommand(command)}`,
            }),
          ),
    );
  }),
);
