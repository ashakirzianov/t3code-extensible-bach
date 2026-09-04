/**
 * The web entry: the ES module the host `import()`s and mounts.
 *
 * The host loads this with a same-origin dynamic `import()`, the only strategy
 * that executes under the desktop's Content-Security-Policy (see
 * spikes/electron-runtime.md). Two constraints follow, and both are enforced by
 * the build rather than by hoping:
 *
 *   - No `eval` and no `new Function`. `script-src` carries no 'unsafe-eval',
 *     so any bundler mode that emits `eval()` — webpack's `eval-source-map`,
 *     dev-mode HMR wrappers — produces a bundle that cannot run at all.
 *   - No `blob:` or `data:` URLs for further code loading. Static and dynamic
 *     `import()` of same-origin paths is the only route in.
 *
 * This module brings its own React. Two Reacts on one page are only a problem
 * when one renders components from the other's tree, which never happens here:
 * the host hands over a plain DOM container and this owns everything inside it.
 */
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Bundled by the build into a sibling entry.css, which the manifest declares
// and the host injects. Kept out of the JS so no style is applied by script.
import "./styles.css";

import { App } from "./App.js";
import type { HostApi } from "./hostApi.js";

/**
 * Roots keyed by container, not by a module-level singleton.
 *
 * The same extension can be mounted twice in one page under two different
 * environments, so nothing here may be keyed by extension name or held in a
 * module-scope variable that assumes a single instance.
 */
const roots = new WeakMap<Element, Root>();

/** Called by the host to mount the extension into a container it owns. */
export function mount(container: Element, hostApi: HostApi, subPath: string): void {
  const existing = roots.get(container);
  const root = existing ?? createRoot(container);
  if (!existing) roots.set(container, root);
  root.render(
    <StrictMode>
      <App hostApi={hostApi} subPath={subPath} />
    </StrictMode>,
  );
}

/**
 * Called by the host before it discards the container.
 *
 * Unmounting is what makes navigating away and back cheap, and what stops a
 * pending fetch from calling setState on a torn-down tree.
 */
export function unmount(container: Element): void {
  const root = roots.get(container);
  if (!root) return;
  roots.delete(container);
  root.unmount();
}
