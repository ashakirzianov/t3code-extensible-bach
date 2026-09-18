import { describe, expect, it } from "vite-plus/test";

import { chunkReloadWithinCooldown, markChunkReloadAttempt } from "./chunkReloadCooldown";

const fakeStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  } as Storage;
};

const blockedStorage = () =>
  ({
    getItem: () => {
      throw new Error("storage is blocked");
    },
    setItem: () => {
      throw new Error("storage is blocked");
    },
  }) as unknown as Storage;

describe("the floor under reload-at-most-once", () => {
  it("lets the first reload through", () => {
    const storage = fakeStorage();
    expect(chunkReloadWithinCooldown(1_000, () => storage)).toBe(false);
  });

  /*
   * The loop this exists to stop: every reload boots successfully, upstream's
   * guard is cleared by that boot, and the route's own import fails again. Only
   * a record that survives the reload can tell the second one from the first.
   */
  it("stops a second reload a fraction of a second later", () => {
    const storage = fakeStorage();
    markChunkReloadAttempt(1_000, () => storage);
    expect(chunkReloadWithinCooldown(1_135, () => storage)).toBe(true);
  });

  it("allows a reload again once a minute has passed, so a real stale deploy still recovers", () => {
    const storage = fakeStorage();
    markChunkReloadAttempt(1_000, () => storage);
    expect(chunkReloadWithinCooldown(61_000, () => storage)).toBe(false);
  });

  it("treats a clock that went backwards as a fresh session rather than a lock-out", () => {
    const storage = fakeStorage();
    markChunkReloadAttempt(10_000, () => storage);
    expect(chunkReloadWithinCooldown(5_000, () => storage)).toBe(false);
  });

  it("does not decide anything when storage is blocked", () => {
    // Upstream's guard already refuses to reload at all without storage, so
    // this must not be the thing that answers.
    expect(chunkReloadWithinCooldown(1_000, blockedStorage)).toBe(false);
    expect(() => markChunkReloadAttempt(1_000, blockedStorage)).not.toThrow();
  });

  it("ignores a value that is not a timestamp", () => {
    const storage = fakeStorage({ "t3code:chunk-load-reload-at": "soon" });
    expect(chunkReloadWithinCooldown(1_000, () => storage)).toBe(false);
  });
});
