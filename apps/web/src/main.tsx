import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";
import { chunkReloadWithinCooldown, markChunkReloadAttempt } from "./lib/chunkReloadCooldown";
import { isExtensionBundlePreloadError } from "./extensions/bundleImport";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// A failed split-chunk fetch usually means the hashed assets went stale under
// a deploy; one guarded reload picks up the fresh index.html.
let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  // An extension's bundle is not one of this app's chunks: it is fetched by URL
  // at mount time, and a broken one is the extension's problem. Left
  // unprevented so it still rejects the import and the extension view shows its
  // own failure, and not counted as a chunk failure so a genuinely clean boot
  // still re-arms the guard.
  if (isExtensionBundlePreloadError(event)) return;
  chunkLoadFailed = true;
  // A successful boot clears the guard, so a route whose own import always
  // fails would reload on every boot. A second reload inside a minute is a
  // loop, not a stale deploy.
  if (chunkReloadWithinCooldown()) return;
  if (reloadOnceForChunkLoadError()) {
    markChunkReloadAttempt();
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = <AppRoot router={router} />;

// Managed auth is cloud-only, and the Electron Clerk provider bundles the full
// clerk-js runtime. Loading only the selected runtime as a split chunk keeps
// every Clerk byte out of the startup graph for local-mode users, and keeps
// the bundled clerk-js out of the browser build entirely.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

// The index.html boot splash lives inside #root, and React's first commit
// clears it. Resolve everything that first commit needs, the selected
// managed-auth runtime and the initial route's split chunks, before
// rendering, so the splash holds until real UI paints instead of dropping to
// a blank window while chunks download.
export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  router.load(),
])
  .then(([ManagedAuthShell]) => {
    // A route chunk failure still resolves router.load(): the error is parked in
    // the lazy component and surfaces through the route error boundary. Skip the
    // paint when a reload is on its way, and only re-arm the guard after a boot
    // that fetched every chunk it asked for.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    // Let the bootstrap entry show the error unless a reload is already scheduled.
    if (reloadScheduled) return;
    throw error;
  });
