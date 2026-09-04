import { assert, describe, it } from "@effect/vitest";

import { formatFatalStartupLine, parseFatalStartupLine } from "./fatalStartup.ts";

describe("fatal startup marker", () => {
  it("round-trips a failure through one line", () => {
    const failure = {
      tag: "DatabaseMigratedAheadError",
      message: "This T3 Code build cannot open /Users/x/.t3/userdata: schema 49 vs 47.",
    };

    const line = formatFatalStartupLine(failure);
    assert.notInclude(line, "\n");
    assert.deepEqual(parseFatalStartupLine(line), failure);
  });

  it("keeps a multi-line message on one line", () => {
    const line = formatFatalStartupLine({ tag: "SomeError", message: "first\nsecond\n\nthird" });

    assert.notInclude(line, "\n");
    assert.equal(parseFatalStartupLine(line)?.message, "first second third");
  });

  it("survives the surrounding whitespace of a log stream", () => {
    const line = formatFatalStartupLine({ tag: "SomeError", message: "boom" });

    assert.deepEqual(parseFatalStartupLine(`\r\n  ${line}  `), {
      tag: "SomeError",
      message: "boom",
    });
  });

  it("ignores lines that are not the marker", () => {
    for (const line of [
      "",
      "   ",
      "INFO: Listening on http://127.0.0.1:3773",
      "T3CODE_FATAL_STARTUP",
      "T3CODE_FATAL_STARTUP OnlyATag",
      "prefixed T3CODE_FATAL_STARTUP SomeError boom",
    ]) {
      assert.isUndefined(parseFatalStartupLine(line), line);
    }
  });
});
