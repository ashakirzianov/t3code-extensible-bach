# Clean-room acceptance run — diagnostic report

Fill this in after the run, from Anton's notes and the transcript
([`read-transcript.md`](read-transcript.md)). Design §14 scores this **as a diagnostic, not
pass/fail**: the point is the list of gaps, not a verdict.

One rule while writing it: **do not propose tuning the guide toward this spec.** A fix that
would only have helped someone building this particular extension is not a fix; the guide has
to stay general or the next run proves nothing.

---

## Run

|                   |                                |
| ----------------- | ------------------------------ |
| Date              |                                |
| Fork commit       |                                |
| Provider / model  |                                |
| Home              | `.t3-acceptance`               |
| Working folder    | `~/acceptance/bach-clean`      |
| Wall clock        | start → end                    |
| Builder turns     |                                |
| Pre-flight checks | all four passed / which failed |

## 1. Did it reach a working deploy?

**The headline.** One of:

- **Yes, unaided** — reached a deployable build with no human action but the Deploy click.
- **Yes, with help** — reached it, but only after N questions had to be answered. List them.
- **No** — where it stopped, and why.

Deploy clicks: N. Any other human action: list, or "none".

## 2. Guide gaps — every host source read instead of the guide

**The most valuable signal the run produces.** Each row is a place where the guide failed to
say something the builder needed, and it went and read the host to find out.

| #   | What it read | What it was trying to learn | Where the guide should have said it |
| --- | ------------ | --------------------------- | ----------------------------------- |

Count: N reads of host source, across M distinct files.

Two things that are _not_ guide gaps and should not be listed: reading its **own** folder, and
reading the **reference extension** — that is the guide working. Reading anything under
`apps/`, `packages/`, or `docs/internals/` that is not the two generated guides is a gap.

## 3. Questions asked of the user

Every question the builder asked, verbatim, with what it was actually missing. A question is a
guide gap that got asked out loud instead of researched, so each one belongs in §2's table too.

| #   | Question | What it needed | Guide gap? |
| --- | -------- | -------------- | ---------- |

## 4. Checklist results

| #   | Item                                               | Result | Observation |
| --- | -------------------------------------------------- | ------ | ----------- |
| 1   | Fresh agent lists the six tools                    |        |             |
| 2   | Spawn, `[Bach]` prefix, non-root rejected          |        |             |
| 3   | Derived state changes                              |        |             |
| 4   | Message waits, wake carries no content, drain once |        |             |
| 5   | Request: card, badge, `blocked`, answer echoed     |        |             |
| 6   | Notification: one per key, ack silent, reply wakes |        |             |
| 7   | Pin is the host's pin                              |        |             |
| 8   | Restart: no loss, no duplication, ids continue     |        |             |
| 9   | No extension tables in the host database           |        |             |

## 5. Failures, attributed

Every checklist failure and every rough edge, each assigned exactly one cause. **Guide gaps and
protocol gaps get fixed; agent limitations do not.**

| Failure | Cause | Why that cause | Fix |
| ------- | ----- | -------------- | --- |

- **Guide gap** — the protocol supports it; the guide did not say how. Fix the guide, in
  general terms.
- **Protocol gap** — the seam cannot express it, or only awkwardly. Fix the protocol; this is
  the finding worth the cost of the run.
- **Agent limitation** — the guide said it and the protocol allowed it, and the builder still
  got it wrong. Record it; change nothing.

## 6. The shape the extension took

Two paragraphs on what it actually built: how it structured its process, what it did with the
tool registration, storage, and the web entry, and where that differs from the reference
extension. A clean-room build diverging from the reference is evidence about which shape the
protocol really encourages — worth more than any single checklist row.

## 7. What changes

Ordered list of concrete follow-ups, each naming a file. Anything that would only have helped
_this_ spec goes in a separate "deliberately not doing" list underneath, with the reason.
