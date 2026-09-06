import {
  EXTENSION_ASSET_TOKEN_TTL_MS,
  type ExtensionAssetUrlsResult,
  type ExtensionHostApi,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ExtensionLoadError, mountExtension } from "./loader";

/**
 * A stand-in for the host's `document`, recording what the loader links and
 * removes. It is a fake rather than jsdom because what is being tested is the
 * loader's ordering, not the browser's.
 */
function fakeDocument() {
  const links: Array<Record<string, unknown> & { remove: () => void }> = [];
  const head = {
    appendChild: (node: unknown) => {
      links.push(node as (typeof links)[number]);
    },
  };
  return {
    links,
    get linked() {
      return links.filter((link) => link.attached === true);
    },
    document: {
      head: head as unknown as HTMLHeadElement,
      createElement: () => {
        const link = {
          rel: "",
          href: "",
          dataset: {} as Record<string, string>,
          attached: true,
          remove() {
            this.attached = false;
          },
        };
        return link as unknown as HTMLLinkElement;
      },
    },
  };
}

/** The minted URLs, with the fields the loader does not read filled in once. */
const assets = (input: {
  readonly entry: string;
  readonly css?: string;
}): ExtensionAssetUrlsResult => ({
  name: "bach" as ExtensionAssetUrlsResult["name"],
  expiresAt: Date.now() + EXTENSION_ASSET_TOKEN_TTL_MS,
  ...input,
});

const container = { tagName: "DIV" } as unknown as Element;
const hostApi = {} as ExtensionHostApi;

const fakeModule = () => {
  const calls: Array<{ readonly call: string; readonly subPath?: string }> = [];
  return {
    calls,
    module: {
      mount: (_container: Element, _hostApi: ExtensionHostApi, subPath: string) => {
        calls.push({ call: "mount", subPath });
      },
      unmount: () => {
        calls.push({ call: "unmount" });
      },
    },
  };
};

describe("extension loader", () => {
  it("links the stylesheet before mounting and removes it on dispose", async () => {
    const dom = fakeDocument();
    const fake = fakeModule();
    const order: string[] = [];

    const handle = await mountExtension({
      deps: {
        document: dom.document,
        importModule: async (url) => {
          order.push(`import:${url}`);
          // The stylesheet must already be linked by the time the module runs,
          // so the extension's first frame is styled.
          expect(dom.linked).toHaveLength(1);
          return fake.module;
        },
      },
      extensionName: "bach",
      assets: assets({ entry: "/api/extensions/bach/assets/web/entry.js", css: "/css/entry.css" }),
      container,
      hostApi,
      subPath: "/",
    });

    expect(order).toEqual(["import:/api/extensions/bach/assets/web/entry.js"]);
    expect(fake.calls).toEqual([{ call: "mount", subPath: "/" }]);
    expect(dom.linked).toHaveLength(1);
    expect(dom.links[0]?.href).toBe("/css/entry.css");

    await handle.dispose();
    expect(fake.calls).toEqual([{ call: "mount", subPath: "/" }, { call: "unmount" }]);
    expect(dom.linked).toHaveLength(0);
  });

  it("re-mounts with the new sub-path instead of tearing the tree down", async () => {
    const dom = fakeDocument();
    const fake = fakeModule();
    const handle = await mountExtension({
      deps: { document: dom.document, importModule: async () => fake.module },
      extensionName: "bach",
      assets: assets({ entry: "/entry.js" }),
      container,
      hostApi,
      subPath: "/",
    });

    await handle.setSubPath("/agents/7");

    expect(fake.calls).toEqual([
      { call: "mount", subPath: "/" },
      { call: "mount", subPath: "/agents/7" },
    ]);
  });

  it("stops responding to navigation once disposed", async () => {
    const dom = fakeDocument();
    const fake = fakeModule();
    const handle = await mountExtension({
      deps: { document: dom.document, importModule: async () => fake.module },
      extensionName: "bach",
      assets: assets({ entry: "/entry.js" }),
      container,
      hostApi,
      subPath: "/",
    });

    await handle.dispose();
    await handle.setSubPath("/agents/7");
    await handle.dispose();

    expect(fake.calls).toEqual([{ call: "mount", subPath: "/" }, { call: "unmount" }]);
  });

  it("names the extension when the bundle cannot be loaded, and leaves no stylesheet", async () => {
    const dom = fakeDocument();

    const failure = await mountExtension({
      deps: {
        document: dom.document,
        importModule: () => Promise.reject(new Error("404 Not Found")),
      },
      extensionName: "bach",
      assets: assets({ entry: "/entry.js", css: "/entry.css" }),
      container,
      hostApi,
      subPath: "/",
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ExtensionLoadError);
    const error = failure as ExtensionLoadError;
    expect(error.kind).toBe("import");
    expect(error.extensionName).toBe("bach");
    expect(error.message).toContain("bach");
    expect(error.message).toContain("404 Not Found");
    expect(dom.linked).toHaveLength(0);
  });

  it("rejects a module that is not a web entry rather than mounting nothing", async () => {
    const dom = fakeDocument();

    const failure = await mountExtension({
      deps: { document: dom.document, importModule: async () => ({ default: "not a module" }) },
      extensionName: "bach",
      assets: assets({ entry: "/entry.js", css: "/entry.css" }),
      container,
      hostApi,
      subPath: "/",
    }).catch((cause: unknown) => cause);

    expect((failure as ExtensionLoadError).kind).toBe("contract");
    expect((failure as ExtensionLoadError).message).toContain("mount and unmount");
    expect(dom.linked).toHaveLength(0);
  });

  it("surfaces a mount that throws, and does not leave the stylesheet behind", async () => {
    const dom = fakeDocument();

    const failure = await mountExtension({
      deps: {
        document: dom.document,
        importModule: async () => ({
          mount: () => {
            throw new Error("render failed");
          },
          unmount: () => {},
        }),
      },
      extensionName: "bach",
      assets: assets({ entry: "/entry.js", css: "/entry.css" }),
      container,
      hostApi,
      subPath: "/",
    }).catch((cause: unknown) => cause);

    expect((failure as ExtensionLoadError).message).toContain("render failed");
    expect(dom.linked).toHaveLength(0);
  });
});
