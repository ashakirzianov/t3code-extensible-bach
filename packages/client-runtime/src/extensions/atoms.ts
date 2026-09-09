import { EXTENSION_ADMIN_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

/**
 * The client's view of one environment's extensions.
 *
 * `subscribe` is the live one and what the nav renders from; it opens with the
 * current list, so nothing has to `list` first. `list` stays for the one-shot
 * read a client makes before it has a subscription — a server that does not
 * speak `subscribe` still answers it.
 */
export function createExtensionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const adminScheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:extensions:list",
      tag: EXTENSION_ADMIN_WS_METHODS.list,
      staleTimeMs: 5_000,
    }),
    subscribe: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:extensions:subscribe",
      tag: EXTENSION_ADMIN_WS_METHODS.subscribe,
    }),
    logs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:extensions:logs",
      tag: EXTENSION_ADMIN_WS_METHODS.logs,
      staleTimeMs: 2_000,
    }),
    /**
     * Minted per mount rather than cached: the URLs carry a short-lived
     * signature, so a cached one outlives its usefulness faster than the atom
     * would evict it.
     */
    /**
     * The same URLs, as cached query data for the nav rows' icons.
     *
     * Refreshed well inside the signature's one-hour life, the way workspace
     * asset URLs are (`state/assets.ts`): a row that is on screen for an hour
     * must not start showing a broken image.
     */
    assetUrlsQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:extensions:asset-urls-query",
      tag: EXTENSION_ADMIN_WS_METHODS.assetUrls,
      staleTimeMs: 5 * 60_000,
      refreshIntervalMs: 30 * 60_000,
      idleTtlMs: 60 * 60_000,
    }),
    assetUrls: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:asset-urls",
      tag: EXTENSION_ADMIN_WS_METHODS.assetUrls,
      scheduler: adminScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.name]),
      },
    }),
    /**
     * Deploy is a human click in host UI and nothing else — no extension and no
     * agent can reach this method, by design (design §6.6). Serial per
     * extension so a double click cannot start two stop/rehash/start cycles.
     */
    deploy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:deploy",
      tag: EXTENSION_ADMIN_WS_METHODS.deploy,
      scheduler: adminScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.name]),
      },
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:install",
      tag: EXTENSION_ADMIN_WS_METHODS.install,
      scheduler: adminScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.path]),
      },
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:remove",
      tag: EXTENSION_ADMIN_WS_METHODS.remove,
      scheduler: adminScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.name]),
      },
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:extensions:set-enabled",
      tag: EXTENSION_ADMIN_WS_METHODS.setEnabled,
      scheduler: adminScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.name]),
      },
    }),
  };
}
