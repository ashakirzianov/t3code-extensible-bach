# The in-app preview tools reported passes that were not real

Recorded on 2026-09-07 while doing the browser pass of the extension web
surface. This is about the tooling, not the seam; it is here because the seam's
verification depended on it and nearly shipped false evidence.

## What happened

Driving the T3 web app through the collaborative-browser `preview_*` tools
produced a clean run of confirmations — sidebar entry present, extension mounted,
stylesheet injected, status grid loaded. All of it was false. The tab was sitting
on `/welcome`, unpaired, with none of those elements in the document.

The tell was that nothing ever failed. A control settled it:

```
preview_wait_for { locator: ".t3ref-this-class-does-not-exist" }  →  {}
```

`preview_wait_for` with a `locator:` returns success for a selector that cannot
match anything. Every locator-based confirmation in that run was worthless.

## Which calls behaved how

| Call                               | Behaviour                                                          |
| ---------------------------------- | ------------------------------------------------------------------ |
| `preview_wait_for` with `locator:` | **Always succeeds**, including for impossible selectors. Unusable. |
| `preview_wait_for` with `text:`    | Always times out, including for text plainly on the page.          |
| `preview_snapshot`                 | Always "Preview snapshot failed."                                  |
| `preview_evaluate`                 | Times out after 15s on every expression, including `1+1`.          |
| `preview_click`                    | "failed on client preview-…"                                       |
| `preview_navigate`                 | Works, and its returned URL is trustworthy.                        |
| `preview_status`                   | Works; URL and title are trustworthy.                              |

Three separate pairing tokens and two fresh tabs never produced a paired session,
so the browser context may have been failing to hold cookies as well.

Worth noting because it may be the cause: the page under test was itself a T3
Code instance, and the driving browser is T3's own in-app browser. Driving T3
with T3 puts two automation surfaces on one page.

## What to do instead

Drive a real headless Chromium from a script. Playwright installs and runs here
without trouble:

```bash
npx -y playwright@latest install chromium
```

The browser pass in [`e2e-web-2026-09-06.md`](e2e-web-2026-09-06.md) was redone
that way and found a genuine defect the preview tools had "confirmed" as working.

## The rule this leaves behind

**A verification tool that cannot fail has not verified anything.** Any new
automation surface gets one negative control before its passes are believed — ask
it for something that must not exist, and check that it says no.
