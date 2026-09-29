import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { JSDOM } from "jsdom";
import { describe, expect } from "vite-plus/test";

import { automationWaitForProbe } from "./AutomationWaitForProbe.ts";
import { playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";

// Runs the probe against the real pinned Playwright runtime, installed the same
// way the preview installs it, so the test covers the runtime's actual return
// values rather than a stand-in.
const pageWithPlaywright = Effect.fn("pageWithPlaywright")(function* () {
  const dom = new JSDOM(`<body><button>Send</button><p class="greeting">Hello there</p></body>`, {
    url: "https://example.test/chat",
    runScripts: "outside-only",
  });
  dom.window.eval(yield* playwrightInjectedRuntimeInstallExpression());
  return (conditions: { readonly locator?: string; readonly urlIncludes?: string }): unknown =>
    dom.window.eval(
      automationWaitForProbe({
        locatorJson: conditions.locator === undefined ? null : JSON.stringify(conditions.locator),
        textJson: null,
        urlIncludesJson:
          conditions.urlIncludes === undefined ? null : JSON.stringify(conditions.urlIncludes),
      }),
    );
});

describe("automationWaitForProbe", () => {
  effectIt.effect("does not match a locator that matches nothing", () =>
    Effect.gen(function* () {
      const probe = yield* pageWithPlaywright();
      expect(probe({ locator: ".t3ref-this-class-does-not-exist" })).toEqual({ matched: false });
      expect(probe({ locator: "role=button[name='Cancel']" })).toEqual({ matched: false });
    }),
  );

  effectIt.effect("matches locators that are present", () =>
    Effect.gen(function* () {
      const probe = yield* pageWithPlaywright();
      expect(probe({ locator: "css=p.greeting" })).toEqual({ matched: true });
      expect(probe({ locator: "role=button[name='Send']" })).toEqual({ matched: true });
    }),
  );

  effectIt.effect("requires every condition to match", () =>
    Effect.gen(function* () {
      const probe = yield* pageWithPlaywright();
      expect(probe({ locator: "css=p.greeting", urlIncludes: "/chat" })).toEqual({
        matched: true,
      });
      expect(probe({ locator: "css=p.greeting", urlIncludes: "/settings" })).toEqual({
        matched: false,
      });
      expect(probe({ locator: "css=p.missing", urlIncludes: "/chat" })).toEqual({
        matched: false,
      });
    }),
  );

  effectIt.effect("reports an unparseable locator instead of matching", () =>
    Effect.gen(function* () {
      const probe = yield* pageWithPlaywright();
      expect(probe({ locator: "role=[" })).toMatchObject({ invalidSelector: true });
    }),
  );
});
