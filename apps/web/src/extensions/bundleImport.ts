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
 * The extension-bundle imports currently in flight, each with the moment it
 * stops counting as one.
 *
 * The wrapper's `catch` runs while the awaited promise below is still pending,
 * so an entry that is still fresh at dispatch time means the failure is
 * plausibly ours. A set of entries rather than a flag because two views can
 * mount at once — a sidebar entry and a page — and the second finishing must not
 * un-arm the first.
 *
 * **Why it expires.** `finally` covers every way an import can *settle*, but not
 * an import that never settles: a server that accepts the connection and then
 * answers nothing leaves the entry up for the life of the tab, and while it is
 * up this module would claim every host chunk failure as well. So a fresh
 * import is a short-lived claim, not a standing one. Thirty seconds is far
 * longer than a bundle fetch from loopback and far shorter than a session.
 */
const IN_FLIGHT_WINDOW_MS = 30_000;

const inFlight = new Set<{ readonly expiresAt: number }>();

/** The bundle import itself, and the only place an in-flight claim is made. */
export async function importExtensionBundle(url: string): Promise<unknown> {
  const claim = { expiresAt: Date.now() + IN_FLIGHT_WINDOW_MS };
  inFlight.add(claim);
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    inFlight.delete(claim);
  }
}

function hasFreshImportInFlight(now: number): boolean {
  let fresh = false;
  for (const claim of inFlight) {
    // An entry past its window is one whose import never settled. Dropping it
    // here keeps a hung import from costing more than one wasted object.
    if (claim.expiresAt <= now) inFlight.delete(claim);
    else fresh = true;
  }
  return fresh;
}

const BUNDLE_PATH_PREFIXES = [
  `${EXTENSION_ASSET_ROUTE_PREFIX}/`,
  `${EXTENSION_REMOTE_ASSET_ROUTE_PREFIX}/`,
];

/**
 * The URL a preload failure names, when it names one. Chromium's dynamic-import
 * failure reads "Failed to fetch dynamically imported module: <url>", and
 * Vite's CSS preload failure reads "Unable to preload CSS for <dep>"; both put
 * the address in the message, and some builds also hang it on the error.
 */
const URL_IN_MESSAGE = /(?:[a-z][a-z0-9+.-]*:\/\/\S+|\/\S+)/i;

function urlNamedBy(payload: unknown): string | null {
  const described =
    payload instanceof Error
      ? `${payload.message} ${String((payload as { url?: unknown }).url ?? "")}`
      : typeof payload === "string"
        ? payload
        : "";
  return URL_IN_MESSAGE.exec(described)?.[0] ?? null;
}

/**
 * Whether a `vite:preloadError` came from an extension bundle rather than a
 * stale host chunk.
 *
 * **What the error says wins, when it says anything.** A failure that names a
 * URL is self-describing: under a bundle route it is ours however the timing
 * fell, and anywhere else it is the host's even if a bundle import happens to be
 * in flight beside it. That second half matters — without it, any host chunk
 * failing during the seconds a bundle is loading would silently lose its
 * reload.
 *
 * The in-flight claim is the fallback, for a failure that names nothing. It is
 * also the only signal that covers a chunk the bundle imported of its own
 * accord, which the host never awaited — though such a chunk is served from a
 * bundle route and so usually answers for itself.
 *
 * Where it still has to guess, it guesses "not the host's": the cost of a false
 * positive is one missed reload the next navigation re-raises; the cost of a
 * false negative is the loop this exists to end.
 */
export function isExtensionBundlePreloadError(event: Event, now: number = Date.now()): boolean {
  const named = urlNamedBy((event as Event & { payload?: unknown }).payload);
  if (named !== null) return BUNDLE_PATH_PREFIXES.some((prefix) => named.includes(prefix));
  return hasFreshImportInFlight(now);
}
