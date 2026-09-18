import { describe, expect, it } from "vite-plus/test";

import { importExtensionBundle, isExtensionBundlePreloadError } from "./bundleImport";

const preloadError = (payload: unknown): Event => {
  const event = new Event("vite:preloadError", { cancelable: true });
  (event as Event & { payload?: unknown }).payload = payload;
  return event;
};

describe("telling an extension bundle's failure from a stale host chunk", () => {
  it("claims a failure that names nothing while a bundle import is in flight", async () => {
    // Vite's preload wrapper dispatches from its own `catch`, which runs while
    // the awaited import below is still pending. That is the moment the
    // listener asks, and the moment the claim has to be up.
    const failing = importExtensionBundle("t3code://app/ext-assets/sig/bach/entry.js").catch(
      (cause: unknown) => cause,
    );
    expect(isExtensionBundlePreloadError(preloadError(new Error("something went wrong")))).toBe(
      true,
    );
    await failing;
  });

  it("lets go once the import has settled", async () => {
    await importExtensionBundle("t3code://app/ext-assets/sig/bach/entry.js").catch(() => null);
    expect(isExtensionBundlePreloadError(preloadError(new Error("something went wrong")))).toBe(
      false,
    );
  });

  /*
   * `finally` covers every way an import can settle. It does not cover one that
   * never does — a server that accepts the connection and answers nothing —
   * and an unbounded claim would swallow every host chunk failure for the rest
   * of the session.
   */
  it("stops claiming once the in-flight window is past", async () => {
    // The claim is raised synchronously and only dropped when the import
    // settles, so an import still pending here stands in for one that never
    // will. Asking from beyond the window is what an import that hung would
    // look like to a preload error minutes later.
    const failing = importExtensionBundle("t3code://app/ext-assets/sig/bach/entry.js").catch(
      (cause: unknown) => cause,
    );
    const opaque = () => preloadError(new Error("something went wrong"));

    expect(isExtensionBundlePreloadError(opaque(), Date.now())).toBe(true);
    expect(isExtensionBundlePreloadError(opaque(), Date.now() + 30_001)).toBe(false);

    await failing;
  });

  /*
   * The counter is a fallback, not an override. A host chunk that goes stale
   * during the seconds an extension is mounting still names its own URL, and
   * losing its reload to a coincidence of timing is exactly the bug this
   * ordering avoids.
   */
  it("still leaves a named host chunk to the host while a bundle import is in flight", async () => {
    const failing = importExtensionBundle("t3code://app/ext-assets/sig/bach/entry.js").catch(
      (cause: unknown) => cause,
    );
    expect(
      isExtensionBundlePreloadError(
        preloadError(
          new Error("Failed to fetch dynamically imported module: /assets/ChatView-Bk3.js"),
        ),
      ),
    ).toBe(false);
    await failing;
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
