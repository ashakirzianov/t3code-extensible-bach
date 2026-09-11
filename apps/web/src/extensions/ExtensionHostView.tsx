import {
  extensionUnavailableMessage,
  type ExtensionNavEntry,
} from "@t3tools/client-runtime/extensions";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  useEnvironmentHttpBaseUrl,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  extensionEnvironment,
  useExtensionHttpPrefixes,
  useExtensionNavEntry,
} from "../state/extensions";
import { useAtomCommand } from "../state/use-atom-command";
import { canLoadExtensionBundle } from "./bundleOrigin";
import { createExtensionHostApi } from "./hostApi";
import { ExtensionLoadError, mountExtension, type ExtensionMountHandle } from "./loader";

/**
 * The host container one extension's web bundle is mounted into.
 *
 * The host owns the element and the lifecycle; the extension owns everything
 * inside it. React never renders into the container after `mount` — the
 * extension's own framework does — so the container is deliberately an empty
 * div with no children in the JSX.
 */

type LoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "mounted" }
  | { readonly status: "failed"; readonly message: string };

export function ExtensionHostView({
  environmentId,
  name,
  subPath,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly subPath: string;
}) {
  const entry = useExtensionNavEntry({ environmentId, name });
  const { environments } = useEnvironments();
  const prefixByEnvironment = useExtensionHttpPrefixes(name);
  const navigate = useNavigate();
  const assetUrls = useAtomCommand(extensionEnvironment.assetUrls);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Read by the host API and the mount effect at call time. Keeping them out of
  // the effect's dependencies is what stops an environment reconnect, or a
  // navigation inside the extension, from remounting the whole tree.
  const liveRef = useRef({ environments, prefixByEnvironment, subPath });
  // Declared before the mount effect so it has already run by the time that one
  // reads the ref, and unconditional so every render refreshes it.
  useEffect(() => {
    liveRef.current = { environments, prefixByEnvironment, subPath };
  });
  const handleRef = useRef<ExtensionMountHandle | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: "idle" });

  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Cross-origin bundles cannot execute under the desktop CSP and there is no
  // fetch-then-evaluate escape hatch, so a remote environment's extension is
  // not loadable from here yet. Proxying it through the client's own backend is
  // the follow-up; until then the route says so rather than failing obscurely.
  // The desktop renderer is the case a bare origin comparison gets wrong — see
  // `canLoadExtensionBundle`.
  const loadable = canLoadExtensionBundle({
    httpBaseUrl,
    rendererHref: window.location.href,
    rendererOrigin: window.location.origin,
    isDesktopRenderer: window.desktopBridge !== undefined,
    environmentId,
    primaryEnvironmentId,
  });

  const navigateToThread = useCallback(
    (threadId: ThreadId, targetEnvironmentId: EnvironmentId) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: targetEnvironmentId, threadId },
      });
    },
    [navigate],
  );

  const canMount = entry !== null && entry.available && loadable;

  // One effect owns the whole mount lifetime. It deliberately does not depend on
  // `subPath`: navigating inside the extension re-runs `mount` with the new
  // sub-path (below) instead of tearing the tree down and rebuilding it.
  useEffect(() => {
    if (!canMount) return;
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    void (async () => {
      try {
        const result = await assetUrls({ environmentId, input: { name } });
        if (result._tag === "Failure") {
          throw new ExtensionLoadError(name, {
            kind: "import",
            message: `Could not locate the ${name} extension's web files.`,
          });
        }
        const handle = await mountExtension({
          deps: {
            importModule: (url) => import(/* @vite-ignore */ url),
            document: window.document,
          },
          extensionName: name,
          assets: result.value,
          container,
          hostApi: createExtensionHostApi({
            extensionName: name,
            environmentId,
            environments: () =>
              liveRef.current.environments.map((candidate) => ({
                environmentId: candidate.environmentId,
                label: candidate.label,
              })),
            prefixByEnvironment: () => liveRef.current.prefixByEnvironment,
            navigateToThread,
          }),
          subPath: liveRef.current.subPath,
        });
        if (cancelled) {
          await handle.dispose();
          return;
        }
        handleRef.current = handle;
        setLoad({ status: "mounted" });
      } catch (cause) {
        if (cancelled) return;
        setLoad({
          status: "failed",
          message:
            cause instanceof ExtensionLoadError
              ? cause.message
              : `Could not load the ${name} extension.`,
        });
      }
    })();
    return () => {
      cancelled = true;
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle !== null) void handle.dispose();
    };
  }, [assetUrls, canMount, environmentId, name, navigateToThread]);

  useEffect(() => {
    if (load.status !== "mounted") return;
    void handleRef.current?.setSubPath(subPath);
  }, [load.status, subPath]);

  if (entry === null) {
    return (
      <ExtensionMessage>No extension named {name} is installed on this server.</ExtensionMessage>
    );
  }
  if (!loadable) {
    return (
      <ExtensionMessage>
        {entry.label} runs on a remote server, and its interface cannot be loaded from here yet.
      </ExtensionMessage>
    );
  }
  const unavailable = extensionUnavailableMessage(entry);
  if (unavailable !== null) {
    return <ExtensionMessage>{unavailable}</ExtensionMessage>;
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {load.status === "failed" ? <ExtensionMessage>{load.message}</ExtensionMessage> : null}
      {/* The scroll container. Its box stays bounded (min-h-0 in a viewport-
          high chain), so a plain-flowing extension page scrolls here by
          default, while one that sizes its root to 100% and runs its own
          scroll region never overflows this box and never sees a second
          scrollbar. Both axes: a wide table should scroll, not be clipped. */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain"
        data-extension={name}
        data-environment={environmentId}
        hidden={load.status !== "mounted"}
        ref={containerRef}
      />
    </div>
  );
}

function ExtensionMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <p className="max-w-prose text-center text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export type { ExtensionNavEntry };
