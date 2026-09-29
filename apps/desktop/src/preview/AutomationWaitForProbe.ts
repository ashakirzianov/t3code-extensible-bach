/**
 * The in-page expression `preview_wait_for` polls until it reports a match.
 *
 * Every argument is a JSON-encoded string literal (or null when that condition
 * was not requested). The locator branch relies on the Playwright runtime that
 * `ensurePlaywrightInjected` installs as `globalThis.__t3PlaywrightInjected`.
 *
 * Playwright's `InjectedScript.querySelector` returns `undefined`, not `null`,
 * when nothing matches, so the match test must be a truthiness check. A strict
 * `!== null` comparison made every locator wait succeed, including for
 * selectors that cannot match anything.
 */
export function automationWaitForProbe(conditions: {
  readonly locatorJson: string | null;
  readonly textJson: string | null;
  readonly urlIncludesJson: string | null;
}): string {
  const { locatorJson, textJson, urlIncludesJson } = conditions;
  const selectorMatched = locatorJson
    ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return Boolean(injected.querySelector(injected.parseSelector(${locatorJson}), document, false)); })()`
    : "true";
  const textMatched = textJson ? `(document.body?.innerText || "").includes(${textJson})` : "true";
  const urlMatched = urlIncludesJson ? `location.href.includes(${urlIncludesJson})` : "true";
  return `(() => {
    try {
      const selectorMatched = ${selectorMatched};
      const textMatched = ${textMatched};
      const urlMatched = ${urlMatched};
      return { matched: selectorMatched && textMatched && urlMatched };
    } catch (error) {
      return { invalidSelector: true, message: String(error) };
    }
  })()`;
}
