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

## Diagnosis (2026-09-29)

Worked from the code on branch `fix/preview-harness`, without re-running the
original session, so the causes below are proved from source and unit tests,
not replayed against that tab. The "two automation surfaces" theory does not
hold up: a guest page gets no `desktopBridge` (the preview preload exposes
nothing), so a T3 page under test is an ordinary web client and never hosts
automation itself.

| Symptom                               | Cause                                                                                                                                                                                                                                                                                                                           | State                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `locator:` wait always succeeds       | Playwright's injected `querySelector` returns `undefined` on no match; the probe tested `!== null`.                                                                                                                                                                                                                             | Fixed, tested against the real runtime.          |
| `text:` wait always times out         | The desktop wait and the broker both defaulted to 15s, and the host spends part of that first, so a failing wait always lost to the broker, which also drops the host's connection. The text was probably really absent: the tab was on `/welcome`.                                                                             | Race fixed. Not a false negative in the matcher. |
| `preview_evaluate` times out on `1+1` | Every action on a tab runs under one control lock, and evaluate had no deadline. One evaluate awaiting a promise that never settles holds the lock for good. Every later call on the tab then queues and times out. Awaiting a `requestAnimationFrame` in a tab that gets no frames is enough (see `bach/preview-raf-missing`). | Fixed: evaluate gives up before the broker does. |
| `preview_snapshot` fails              | Most likely `capturePage` stalling: it needs the guest to produce frames, and a guest in a hidden or occluded app window produces none. The snapshot retries three 1s captures, then fails. A wedged control lock (above) has the same effect.                                                                                  | Likely fixed by keeping automated tabs painting. |
| `preview_click` "failed on client"    | Not diagnosable from the message, and that is the defect: see below. Given the `/welcome` page, the likely underlying error is "target not found".                                                                                                                                                                              | Open.                                            |
| Pairing never held                    | Not investigated.                                                                                                                                                                                                                                                                                                               | Open.                                            |

**Open: desktop failures lose their type crossing Electron IPC.** Desktop
automation errors reach the renderer through `ipcMain.handle`, which passes
only the error's message. The web host then wraps every one of them as
`PreviewAutomationOperationError`, so the agent sees "Preview automation
<operation> failed on client preview-…" for not-found, invalid-selector,
timed-out and evaluation-threw alike. The host's `_tag` mapping for
not-editable targets only works in its unit tests. A fix needs the desktop
to return typed failures as values, which changes the automation IPC
contract, so it was left for a decision.

**Paint.** A guest parked outside the window (every preview tab not on
screen) gets no animation frames at all while still reporting
`visibilityState: "visible"`. A guest inside the window gets about 60 per
second, even when it is behind the app's own content. Both were measured in
a throwaway Electron 44.4.2 app. Automated tabs are now kept in the window
and unthrottled until 30s after the agent's last call.

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
