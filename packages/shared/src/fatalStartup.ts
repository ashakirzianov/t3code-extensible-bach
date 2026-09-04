/**
 * One line the server writes to stderr when it gives up at startup for a
 * reason a restart cannot fix and the user has to read.
 *
 * A desktop shell supervising the backend as a child process only sees an exit
 * code, so a permanent failure is indistinguishable from a crash and gets
 * restarted forever behind a spinner. This marker is the smallest signal that
 * carries the message across that boundary: one line, no framing, safe to
 * appear in a log file, and ignorable by anything that does not know it.
 */

export const FATAL_STARTUP_MARKER = "T3CODE_FATAL_STARTUP";

export interface FatalStartupFailure {
  /** The error's `_tag`, so a reader can act on the kind, not the prose. */
  readonly tag: string;
  /** Shown to the user verbatim. */
  readonly message: string;
}

/** Collapses whitespace so the failure survives as exactly one line. */
const oneLine = (value: string) => value.replaceAll(/\s+/gu, " ").trim();

export const formatFatalStartupLine = (failure: FatalStartupFailure): string =>
  `${FATAL_STARTUP_MARKER} ${oneLine(failure.tag)} ${oneLine(failure.message)}`;

/**
 * Reads a marker line back, or `undefined` for any other line — output
 * scanners see far more lines that are not this one.
 */
export const parseFatalStartupLine = (line: string): FatalStartupFailure | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${FATAL_STARTUP_MARKER} `)) return undefined;

  const rest = trimmed.slice(FATAL_STARTUP_MARKER.length + 1).trimStart();
  const separator = rest.indexOf(" ");
  if (separator <= 0) return undefined;

  const message = rest.slice(separator + 1).trim();
  if (message === "") return undefined;

  return { tag: rest.slice(0, separator), message };
};
