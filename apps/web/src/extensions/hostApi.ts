import { extensionFetch } from "@t3tools/client-runtime/extensions";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  EnvironmentId,
  ExtensionHostApi,
  ExtensionHostEnvironment,
  ExtensionHttpPrefix,
  ThreadId,
} from "@t3tools/contracts";

import { readPreparedConnection } from "../state/session";

/**
 * Building the object a mounted extension is handed.
 *
 * Everything here is a capability the extension cannot get for itself from
 * inside the host's page: the host's credential for an environment, the set of
 * environments this client is connected to, and the host's router. Anything an
 * extension can do from its own process — dispatching commands, subscribing to
 * threads — it does over its own WebSocket, not through this.
 */

export class ExtensionHostApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionHostApiError";
  }
}

export interface ExtensionHostApiInput {
  readonly extensionName: string;
  readonly environmentId: EnvironmentId;
  /**
   * Read at call time rather than captured, so an extension that outlives an
   * environment reconnect sees the current set instead of the one that existed
   * when it mounted.
   */
  readonly environments: () => ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  /**
   * The extension's registered HTTP prefix per environment. An environment
   * missing from this map has no route for the extension — because it is not
   * running, or because it registered no prefix — and `fetch` says so rather
   * than issuing a request that would 404 with no explanation.
   */
  readonly prefixByEnvironment: () => ReadonlyMap<EnvironmentId, ExtensionHttpPrefix>;
  readonly navigateToThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
}

export function createExtensionHostApi(input: ExtensionHostApiInput): ExtensionHostApi {
  return {
    environmentId: input.environmentId,
    get environments(): ReadonlyArray<ExtensionHostEnvironment> {
      return input.environments().map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        current: environment.environmentId === input.environmentId,
      }));
    },
    fetch: (environmentId, path, init) => {
      const prepared = readPreparedConnection(environmentId);
      if (prepared === null) {
        return Promise.reject(
          new ExtensionHostApiError(`Not connected to environment ${environmentId}.`),
        );
      }
      const prefix = input.prefixByEnvironment().get(environmentId);
      if (prefix === undefined) {
        return Promise.reject(
          new ExtensionHostApiError(
            `The ${input.extensionName} extension has no HTTP routes on environment ${environmentId}.`,
          ),
        );
      }
      return extensionFetch({ prepared, environmentId, prefix, path, init });
    },
    // The same resolution the host's own sidebar gives a favicon, so an
    // extension draws what the sidebar draws on every client.
    resolveAssetUrl: (environmentId, path) => {
      // Root-relative only: `//host/…` is protocol-relative and would resolve
      // to another origin, and an absolute URL is not a host-minted path.
      if (!path.startsWith("/") || path.startsWith("//")) return null;
      const prepared = readPreparedConnection(environmentId);
      return prepared === null ? null : resolveAssetUrl(prepared.httpBaseUrl, path);
    },
    navigateToThread: (threadId, environmentId) =>
      input.navigateToThread(threadId, environmentId ?? input.environmentId),
  };
}
