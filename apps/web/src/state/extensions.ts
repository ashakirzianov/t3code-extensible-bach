import { useAtomValue } from "@effect/atom-react";
import {
  createExtensionEnvironmentAtoms,
  extensionNavEntries,
  extensionSettingsGroups,
  findExtensionNavEntry,
  type ExtensionEnvironmentList,
  type ExtensionNavEntry,
  type ExtensionSettingsGroup,
} from "@t3tools/client-runtime/extensions";
import type { EnvironmentId, ExtensionHttpPrefix } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

export const extensionEnvironment = createExtensionEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_LIST: ReadonlyArray<never> = [];

/**
 * Every connected environment's extension list, in catalog order.
 *
 * Fans out over the catalog the way `allEnvironmentShellsBootstrappedAtom`
 * does, so subscribing is driven by which environments exist rather than by a
 * component rendering one hook per environment. An environment that has not
 * answered yet contributes nothing and nothing waits on it; one that answered
 * with no extensions stays in the list, because Settings has to be able to say
 * it looked.
 */
export const extensionEnvironmentListsAtom = Atom.make(
  (get): ReadonlyArray<ExtensionEnvironmentList> => {
    const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
    if (Option.isNone(catalog)) return EMPTY_LIST;
    const lists: ExtensionEnvironmentList[] = [];
    for (const environmentId of catalog.value.entries.keys()) {
      const result = get(extensionEnvironment.subscribe({ environmentId, input: {} }));
      const list = Option.getOrNull(AsyncResult.value(result));
      if (list === null) continue;
      const presentation = get(environmentPresentations.presentationAtom(environmentId));
      lists.push({
        environmentId,
        environmentLabel: presentation?.entry.target.label ?? environmentId,
        extensions: list.extensions,
      });
    }
    return lists;
  },
).pipe(Atom.withLabel("web-extensions:environment-lists"));

/** Every extension nav row across every connected environment. */
export const extensionNavEntriesAtom = Atom.make((get): ReadonlyArray<ExtensionNavEntry> =>
  extensionNavEntries(get(extensionEnvironmentListsAtom)),
).pipe(Atom.withLabel("web-extensions:nav-entries"));

/** The same lists as the Settings screen's rows, grouped by environment. */
export const extensionSettingsGroupsAtom = Atom.make((get): ReadonlyArray<ExtensionSettingsGroup> =>
  extensionSettingsGroups(get(extensionEnvironmentListsAtom)),
).pipe(Atom.withLabel("web-extensions:settings-groups"));

export function useExtensionSettingsGroups(): ReadonlyArray<ExtensionSettingsGroup> {
  return useAtomValue(extensionSettingsGroupsAtom);
}

export function useExtensionNavEntries(): ReadonlyArray<ExtensionNavEntry> {
  return useAtomValue(extensionNavEntriesAtom);
}

export function useExtensionNavEntry(
  target: { readonly environmentId: string; readonly name: string } | null,
): ExtensionNavEntry | null {
  const entries = useExtensionNavEntries();
  return target === null ? null : findExtensionNavEntry(entries, target);
}

/**
 * Where one extension's HTTP routes live, per environment — what
 * `hostApi.fetch` needs to address a sibling instance in another environment.
 */
export const extensionHttpPrefixesAtom = Atom.family((name: string) =>
  Atom.make((get): ReadonlyMap<EnvironmentId, ExtensionHttpPrefix> => {
    const prefixes = new Map<EnvironmentId, ExtensionHttpPrefix>();
    for (const list of get(extensionEnvironmentListsAtom)) {
      const status = list.extensions.find((extension) => extension.name === name);
      if (status?.httpPrefix !== undefined) prefixes.set(list.environmentId, status.httpPrefix);
    }
    return prefixes;
  }).pipe(Atom.withLabel(`web-extensions:http-prefixes:${name}`)),
);

export function useExtensionHttpPrefixes(
  name: string,
): ReadonlyMap<EnvironmentId, ExtensionHttpPrefix> {
  return useAtomValue(extensionHttpPrefixesAtom(name));
}
