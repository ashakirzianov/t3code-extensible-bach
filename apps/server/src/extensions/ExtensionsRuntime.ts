/**
 * Wiring the extension registry and supervisor into the running server.
 *
 * Everything the two services need that only exists at runtime is resolved
 * here: the environment id, the socket the host is actually listening on, and
 * a token minter. Depending on `HttpServer` is what orders this after the
 * listener exists, the same way `McpSessionRegistry` gets its endpoint.
 */
import type { ExtensionName, ExtensionToolName } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import packageJson from "../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { PreviewToolkit } from "../mcp/toolkits/preview/tools.ts";
import { EXTENSION_SUBJECT_PREFIX, EXTENSION_TOKEN_SCOPES } from "./ExtensionIdentity.ts";
import { HOST_RESOURCE_URIS } from "./ExtensionMcp.ts";
import * as ExtensionFolderWatcher from "./ExtensionFolderWatcher.ts";
import * as ExtensionRegistry from "./ExtensionRegistry.ts";
import * as ExtensionSupervisor from "./ExtensionSupervisor.ts";

type HttpServerAddress = (typeof HttpServer.HttpServer)["Service"]["address"];

// A wildcard bind is reachable on loopback, which is where the extension
// subprocesses run; anything else is announced as the address it bound. Mirrors
// `McpSessionRegistry`'s endpoint host, for the same reason.
const websocketHostFrom = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const websocketUrlFrom = (address: HttpServerAddress): string =>
  NetAddress.isInetAddress(address)
    ? `ws://${websocketHostFrom(address.address)}:${address.port}/ws`
    : "ws://127.0.0.1/ws";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const httpServer = yield* HttpServer.HttpServer;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const dataRoot = path.join(config.stateDir, "extensions");

    const mintToken = (name: ExtensionName) =>
      auth
        .issueSession({
          subject: `${EXTENSION_SUBJECT_PREFIX}${name}`,
          scopes: EXTENSION_TOKEN_SCOPES,
          label: `Extension ${name}`,
          // Minted per process start, and a restarted process never presents
          // its predecessor's token again, so only the newest session can be
          // live. Replacing in the issuing transaction keeps it one session
          // per extension. The old process has normally been stopped by the
          // time `runOnce` mints, but not necessarily gone: its socket can
          // outlive the stop, and revocation does not close it — only a
          // reconnect with the old token is refused, which a process on its
          // way out has no use for. A `t3 pair` dev token for the same name is
          // replaced too (see protocol.md): the supervisor and a hand-run
          // process cannot both be the extension.
          replaceActiveForSubject: true,
        })
        .pipe(
          Effect.map((session) => session.token),
          Effect.orDie,
        );

    // Derived from the toolkit rather than listed, so a tool added to the host
    // becomes reserved without anyone remembering to update a second list.
    const hostToolNames = Object.values(PreviewToolkit.tools).map(
      (tool) => tool.name as ExtensionToolName,
    );

    return ExtensionSupervisor.layer({
      dataRoot,
      websocketUrl: websocketUrlFrom(httpServer.address),
      mintToken,
      // Under Electron this is the app binary, which needs
      // `ELECTRON_RUN_AS_NODE` to behave as Node rather than launching a
      // second GUI process that never exits.
      nodePath: process.execPath,
      runAsNode: process.versions.electron !== undefined,
      cwd: config.cwd,
      launchFlags: config.extensionLaunchFlags ?? [],
    }).pipe(
      // The real `fs.watch`-backed watcher: this is what makes a finished
      // build light up Deploy without anyone opening Settings.
      Layer.provide(ExtensionFolderWatcher.layer),
      Layer.provideMerge(
        ExtensionRegistry.layer({
          environmentId,
          hostVersion: packageJson.version,
          dataRoot,
          reservedToolNames: hostToolNames,
          // Derived the same way, from the list the host serves its own
          // resources from.
          reservedResourceUris: HOST_RESOURCE_URIS,
        }),
      ),
    );
  }),
);

/**
 * Start the enabled extensions. Separate from the layer above so the services
 * exist — and answer Settings — even when a folder is broken or startup is
 * still in flight.
 */
export const startLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const supervisor = yield* ExtensionSupervisor.ExtensionSupervisor;
    // Reconciles once against the current settings, then keeps reconciling —
    // so installing or removing an extension takes effect without a restart.
    // Unconditional even when nothing is installed: the whole point is that
    // something can be installed later.
    yield* supervisor.watchSettings;
  }),
);
