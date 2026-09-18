/**
 * A floor under `chunkReloadGuard`'s "reload at most once".
 *
 * That guard is a sessionStorage flag cleared by a successful boot, which is
 * the right shape for the case it was written for: a deploy swapped the hashed
 * assets, one reload picks up the fresh `index.html`, and the next stale deploy
 * gets its own reload. It has one weakness, and the extension route found it —
 * when a route's own lazy import fails *every* time, each reload is a
 * successful boot that clears the flag, so "at most once" becomes "once per
 * boot" and the renderer reloads as fast as it can start.
 *
 * Filtering the extension case out of the listener closes that particular loop
 * (`../extensions/bundleImport.ts`). This closes the shape of it: whatever the
 * failing import is, a second reload inside a minute is not a stale deploy, it
 * is a loop, and the error is better surfaced than papered over.
 *
 * **What that costs, stated plainly.** Two *genuine* stale-deploy failures
 * inside the same minute — a deploy that lands twice in quick succession, or a
 * second route's chunk going stale just after the first reload — get one reload
 * between them. The second lands on the route's error boundary instead, and
 * navigating again after the minute is up recovers. That is a real narrowing of
 * upstream's recovery path, accepted because the failure it replaces is a
 * renderer that reloads several times a second and cannot be read or closed.
 *
 * The timestamp is aged out rather than removed, so the last chunk reload's
 * time stays in sessionStorage for the rest of the session. Nothing reads it but
 * this module, and nothing depends on it being cleared.
 *
 * Fork-owned rather than an edit to the guard, so an uptake that rewrites
 * upstream's file does not have to reconcile this.
 */
const COOLDOWN_KEY = "t3code:chunk-load-reload-at";
const COOLDOWN_MS = 60_000;

/**
 * Whether a chunk-load reload happened recently enough that another one would
 * be a loop. A clock that has gone backwards reads as "not recently", which is
 * the same answer as a fresh session.
 */
export function chunkReloadWithinCooldown(
  now: number = Date.now(),
  getStorage: () => Storage = () => window.sessionStorage,
): boolean {
  let stored: string | null;
  try {
    stored = getStorage().getItem(COOLDOWN_KEY);
  } catch {
    // Without storage this cannot remember anything, so it must not be the
    // thing that decides. Upstream's guard already refuses to reload at all in
    // that case.
    return false;
  }
  if (stored === null) return false;
  const at = Number.parseInt(stored, 10);
  if (!Number.isFinite(at)) return false;
  const elapsed = now - at;
  return elapsed >= 0 && elapsed < COOLDOWN_MS;
}

/** Recorded when a reload is actually on its way, not merely considered. */
export function markChunkReloadAttempt(
  now: number = Date.now(),
  getStorage: () => Storage = () => window.sessionStorage,
): void {
  try {
    getStorage().setItem(COOLDOWN_KEY, String(now));
  } catch {
    // Blocked storage never held it; see above.
  }
}
