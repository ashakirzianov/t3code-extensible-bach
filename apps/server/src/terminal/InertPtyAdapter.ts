import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

/**
 * The PTY adapter as the server's config allows it: node-pty, or — on an
 * inert server (`ServerConfig.inert`) — a refusal. A terminal is a shell in a
 * real workspace, which is exactly what an inert copy must not open; node-pty
 * spawns outside the `ChildProcessSpawner` seam, so it is refused here.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    if (!(yield* ServerConfig.isInert)) return NodePtyAdapter.layer;
    return Layer.succeed(
      PtyAdapter.PtyAdapter,
      PtyAdapter.PtyAdapter.of({
        spawn: (input) =>
          Effect.fail(
            new PtyAdapter.PtySpawnError({
              adapter: "inert",
              shell: input.shell,
              cause: new Error("inert server: terminals are off"),
            }),
          ),
      }),
    );
  }),
);
