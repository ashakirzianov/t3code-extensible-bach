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

import packageJson from "../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { PreviewToolkit } from "../mcp/toolkits/preview/tools.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { ServerSettings } from "@t3tools/contracts";
import { EXTENSION_SUBJECT_PREFIX, EXTENSION_TOKEN_SCOPES } from "./ExtensionIdentity.ts";
import * as ExtensionFolderWatcher from "./ExtensionFolderWatcher.ts";
import * as ExtensionRegistry from "./ExtensionRegistry.ts";
import { resolveExtensionSources } from "./ExtensionSources.ts";
import * as ExtensionSupervisor from "./ExtensionSupervisor.ts";

type HttpServerAddress = (typeof HttpServer.HttpServer)["Service"]["address"];

const websocketUrlFrom = (address: HttpServerAddress): string => {
  if (address._tag !== "TcpAddress") return "ws://127.0.0.1/ws";
  const hostname =
    address.hostname === "0.0.0.0" || address.hostname === "::" || address.hostname === "[::]"
      ? "127.0.0.1"
      : address.hostname;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `ws://${host}:${address.port}/ws`;
};

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
    const config = yield* ServerConfig.ServerConfig;
    const supervisor = yield* ExtensionSupervisor.ExtensionSupervisor;
    const settings = yield* ServerSettingsService;
    // A settings file this build cannot read is a reason to run no extensions,
    // not a reason to fail the server's startup.
    const stored = yield* settings.getSettings.pipe(
      Effect.map((current) => current.extensions),
      Effect.orElseSucceed((): ServerSettings["extensions"] => []),
    );
    const sources = resolveExtensionSources({
      settingsEntries: stored,
      launchFlags: config.extensionLaunchFlags ?? [],
    });
    if (sources.length === 0) return;
    yield* supervisor.startAll(sources);
  }),
);
