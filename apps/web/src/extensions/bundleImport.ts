import {
  EXTENSION_ASSET_ROUTE_PREFIX,
  EXTENSION_REMOTE_ASSET_ROUTE_PREFIX,
} from "@t3tools/shared/extensionRemoteAssets";

/**
 * Importing an extension's bundle, and keeping its failures out of the host's
 * stale-chunk machinery.
 *
 * The host reloads itself once when a split chunk 404s, because that usually
 * means a deploy replaced the hashed assets under a page that was already open
 * (`main.tsx`, `lib/chunkReloadGuard.ts`). An extension bundle is not one of
 * those chunks: it is a third party's file, fetched by URL at mount time, and a
 * missing or broken one is the extension's problem, not the host's. Treating it
 * as a stale chunk is how the whole renderer came to reload about five times a
 * second on `/ext/$environmentId/$name` — the guard's "reload at most once" is
 * cleared by a successful boot, and a route whose own import always fails boots
 * successfully every time.
 *
 * **Why the event has to be filtered rather than avoided.** Vite's build
 * rewrites every `import()` expression into `__vitePreload(() => import(url),
 * deps)`, whose `catch` dispatches `vite:preloadError` on `window`.
 * A `@vite-ignore` annotation only suppresses the dependency analysis, not the
 * wrapper — verified by reading the emitted route chunk — and there is no
 * source-level way to attach a `catch` inside the wrapper, because the rewrite
 * wraps the import expression and leaves anything chained onto it outside. So
 * the listener has to know which errors are not its business, and this module
 * is what tells it.
 */

/**
 * How many extension-bundle imports are in flight. The wrapper's `catch` runs
 * while the awaited promise below is still pending, so a non-zero count at
 * dispatch time means the failure is ours.
 *
 * A counter rather than a flag because two views can mount at once — a sidebar
 * entry and a page — and the second finishing must not un-arm the first.
 */
let inFlight = 0;

/** The bundle import itself, and the only place the counter is raised. */
export async function importExtensionBundle(url: string): Promise<unknown> {
  inFlight += 1;
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    inFlight -= 1;
  }
}

const BUNDLE_PATH_PREFIXES = [
  `${EXTENSION_ASSET_ROUTE_PREFIX}/`,
  `${EXTENSION_REMOTE_ASSET_ROUTE_PREFIX}/`,
];

/**
 * Whether a `vite:preloadError` came from an extension bundle rather than a
 * stale host chunk.
 *
 * Two independent answers, either of which is enough:
 *
 * - **A bundle import is in flight.** Exact while it holds, and free of any
 *   assumption about what the error says.
 * - **The error names one of the bundle routes.** A failed dynamic import
 *   reports the URL it could not fetch, so this still recognises a failure
 *   whose timing the counter missed — and it is the only signal available for a
 *   chunk the bundle itself imported, which the host never awaited.
 *
 * Both err towards "not the host's": the cost of a false positive is one missed
 * reload after a deploy, which the next navigation re-raises. The cost of a
 * false negative is the loop this exists to end.
 */
export function isExtensionBundlePreloadError(event: Event): boolean {
  if (inFlight > 0) return true;
  const payload = (event as Event & { payload?: unknown }).payload;
  const described =
    payload instanceof Error
      ? `${payload.message} ${String((payload as { url?: unknown }).url ?? "")}`
      : typeof payload === "string"
        ? payload
        : "";
  return BUNDLE_PATH_PREFIXES.some((prefix) => described.includes(prefix));
}
