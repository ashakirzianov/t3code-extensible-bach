import type {
  ExtensionAssetUrlsResult,
  ExtensionHostApi,
  ExtensionWebModule,
} from "@t3tools/contracts";

/**
 * Loading and mounting one extension's web bundle.
 *
 * The only strategy that executes under the desktop's Content-Security-Policy is
 * a dynamic `import()` of a **same-origin** URL served by the host: `blob:`,
 * `data:`, cross-origin scripts and `eval` are all blocked, and there is no
 * fetch-then-evaluate escape hatch
 * (`docs/internals/extensions/spikes/electron-runtime.md` §1). So the host asks
 * the server for a signed same-origin URL and imports it, and everything else
 * here — the stylesheet link, the mount/unmount ordering — follows from that one
 * constraint.
 *
 * The `import` and `document` are injected so the sequencing can be tested
 * against a fake module instead of a real bundle.
 */

export interface ExtensionLoaderDeps {
  /** Injected so tests can hand back a module without a network or a bundler. */
  readonly importModule: (url: string) => Promise<unknown>;
  readonly document: Pick<Document, "createElement" | "head">;
}

export type ExtensionLoadFailure =
  | { readonly kind: "import"; readonly message: string }
  | { readonly kind: "contract"; readonly message: string };

export interface ExtensionMountHandle {
  /**
   * Re-runs `mount` with a new sub-path. Navigation *inside* an extension must
   * not tear its tree down and rebuild it, so this is deliberately not a
   * dispose-and-load.
   */
  readonly setSubPath: (subPath: string) => Promise<void>;
  /** Unmounts and removes the stylesheet. Safe to call twice. */
  readonly dispose: () => Promise<void>;
}

export class ExtensionLoadError extends Error {
  readonly kind: ExtensionLoadFailure["kind"];
  readonly extensionName: string;

  constructor(extensionName: string, failure: ExtensionLoadFailure) {
    super(failure.message);
    this.name = "ExtensionLoadError";
    this.kind = failure.kind;
    this.extensionName = extensionName;
  }
}

const isWebModule = (value: unknown): value is ExtensionWebModule =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ExtensionWebModule).mount === "function" &&
  typeof (value as ExtensionWebModule).unmount === "function";

const describe = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);

/**
 * Loads the bundle, links its stylesheet, and mounts it into `container`.
 *
 * The stylesheet is linked **before** the module is imported and before `mount`
 * runs, so the first frame the extension paints is already styled. It is removed
 * on dispose because a stylesheet left behind would keep restyling the host
 * after the extension is gone.
 */
export async function mountExtension(input: {
  readonly deps: ExtensionLoaderDeps;
  readonly extensionName: string;
  readonly assets: ExtensionAssetUrlsResult;
  readonly container: Element;
  readonly hostApi: ExtensionHostApi;
  readonly subPath: string;
}): Promise<ExtensionMountHandle> {
  const { deps, assets, container, hostApi, extensionName } = input;

  let styleLink: HTMLLinkElement | null = null;
  if (assets.css !== undefined) {
    const link = deps.document.createElement("link");
    link.rel = "stylesheet";
    link.href = assets.css;
    link.dataset.extension = extensionName;
    deps.document.head.appendChild(link);
    styleLink = link;
  }

  const removeStyleLink = () => {
    styleLink?.remove();
    styleLink = null;
  };

  let module: unknown;
  try {
    module = await deps.importModule(assets.entry);
  } catch (cause) {
    removeStyleLink();
    throw new ExtensionLoadError(extensionName, {
      kind: "import",
      message: `Could not load the ${extensionName} extension: ${describe(cause)}`,
    });
  }

  if (!isWebModule(module)) {
    removeStyleLink();
    throw new ExtensionLoadError(extensionName, {
      kind: "contract",
      message: `The ${extensionName} extension's web entry does not export mount and unmount.`,
    });
  }

  const webModule = module;
  let disposed = false;

  try {
    await webModule.mount(container, hostApi, input.subPath);
  } catch (cause) {
    removeStyleLink();
    throw new ExtensionLoadError(extensionName, {
      kind: "contract",
      message: `The ${extensionName} extension failed while mounting: ${describe(cause)}`,
    });
  }

  return {
    setSubPath: async (subPath: string) => {
      if (disposed) return;
      await webModule.mount(container, hostApi, subPath);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await webModule.unmount(container);
      } finally {
        // The stylesheet goes even if the extension threw on its way out;
        // leaving it would restyle the host for the rest of the session.
        removeStyleLink();
      }
    },
  };
}
