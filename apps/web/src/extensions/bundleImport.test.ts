import { describe, expect, it } from "vite-plus/test";

import { importExtensionBundle, isExtensionBundlePreloadError } from "./bundleImport";

const preloadError = (payload: unknown): Event => {
  const event = new Event("vite:preloadError", { cancelable: true });
  (event as Event & { payload?: unknown }).payload = payload;
  return event;
};

describe("telling an extension bundle's failure from a stale host chunk", () => {
  it("claims a failure raised while a bundle import is in flight", async () => {
    // Vite's preload wrapper dispatches from its own `catch`, which runs while
    // the awaited import below is still pending. That is the moment the
    // listener asks, and the moment the counter has to be up.
    let seen: boolean | null = null;
    const failing = importExtensionBundle("t3code://app/ext-assets/sig/bach/entry.js").catch(
      (cause: unknown) => cause,
    );
    seen = isExtensionBundlePreloadError(preloadError(new Error("nothing to do with it")));
    expect(seen).toBe(true);
    await failing;
  });

  it("lets go once the import has settled", async () => {
    await importExtensionBundle("t3code://app/ext-assets/sig/bach/entry.js").catch(() => null);
    expect(isExtensionBundlePreloadError(preloadError(new Error("/assets/index-abc123.js")))).toBe(
      false,
    );
  });

  /*
   * A chunk the bundle imported itself is one the host never awaited, so the
   * counter is down when it fails. The URL in the error is the only thing left
   * to go on — and it is enough, because both asset routes are prefixes no host
   * chunk is served under.
   */
  it("recognises both bundle routes by the URL the failure names", () => {
    for (const url of [
      "t3code://app/ext-assets/eyJhIjoxfQ.sig/bach/entry.js",
      "t3code://app/__ext-remote/54321/ext-assets/eyJhIjoxfQ.sig/bach/chunk-1.js",
    ]) {
      expect(
        isExtensionBundlePreloadError(
          preloadError(new Error(`Failed to fetch dynamically imported module: ${url}`)),
        ),
      ).toBe(true);
    }
  });

  it("leaves a genuine stale-chunk failure to the host", () => {
    for (const payload of [
      new Error("Failed to fetch dynamically imported module: /assets/ChatView-Bk3.js"),
      "Unable to preload CSS for /assets/index-Cq3.css",
      undefined,
      null,
    ]) {
      expect(isExtensionBundlePreloadError(preloadError(payload))).toBe(false);
    }
  });

  it("rejects, so the extension view can end at its own message", async () => {
    const failure = await importExtensionBundle("t3code://app/ext-assets/sig/bach/entry.js").catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
  });
});
