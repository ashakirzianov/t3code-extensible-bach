/**
 * The spawn contract: everything the host tells an extension at startup.
 *
 * These four variables are the entire interface between the host's supervisor
 * and the extension process. Nothing is read from `cwd` on purpose — a bundled
 * extension may live inside the packaged app's `app.asar`, and a path inside an
 * asar cannot be a process `cwd` (see spikes/electron-runtime.md), so an
 * extension that resolves its own files relative to `cwd` breaks when shipped.
 * Resolve from `import.meta.url` instead.
 */
/** The name the host registered this extension under; see `name` below. */
export const ENV_NAME = "T3_EXT_NAME";
export const ENV_TOKEN = "T3_EXT_TOKEN";
export const ENV_WS_URL = "T3_EXT_WS_URL";
export const ENV_DATA_DIR = "T3_EXT_DATA_DIR";
export const ENV_PROTOCOL_VERSION = "T3_EXT_PROTOCOL_VERSION";

export interface HostEnvironment {
  /**
   * The name the host knows this extension by.
   *
   * Authoritative over the manifest's own `name`: the same built folder can be
   * installed more than once, so the host decides which registration this
   * process is, and `extensions.connect` must use this rather than assume.
   */
  readonly name: string;
  readonly token: string;
  /** Absolute `ws://` or `wss://` URL, connected to verbatim. */
  readonly wsUrl: string;
  /** The per-environment directory this extension owns. It is the only place it may write. */
  readonly dataDirectory: string;
  readonly protocolVersion: number;
}

export class MissingHostEnvironmentError extends Error {
  constructor(readonly missing: ReadonlyArray<string>) {
    super(
      `This is a T3 Code extension: it is started by the host, not run directly.\n` +
        `Missing environment: ${missing.join(", ")}.\n` +
        `To run it by hand, set those variables to a host that is already listening.`,
    );
    this.name = "MissingHostEnvironmentError";
  }
}

/**
 * Reads the spawn contract, or explains precisely what is missing.
 *
 * Failing clearly here is what makes `node dist/server.mjs` a useful thing to
 * type: a human who runs the entry directly gets an explanation, not a stack
 * trace about an undefined URL.
 */
export function readHostEnvironment(source: NodeJS.ProcessEnv = process.env): HostEnvironment {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = source[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };

  const name = required(ENV_NAME);
  const token = required(ENV_TOKEN);
  const wsUrl = required(ENV_WS_URL);
  const dataDirectory = required(ENV_DATA_DIR);
  const rawProtocolVersion = source[ENV_PROTOCOL_VERSION]?.trim();

  if (missing.length > 0) throw new MissingHostEnvironmentError(missing);

  // An absent protocol version means an older host; the manifest's version is
  // what we then negotiate with, and the host rejects it if it cannot speak it.
  const protocolVersion = rawProtocolVersion ? Number.parseInt(rawProtocolVersion, 10) : 1;
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new Error(
      `${ENV_PROTOCOL_VERSION} must be a positive integer, got "${rawProtocolVersion}".`,
    );
  }

  return { name, token, wsUrl, dataDirectory, protocolVersion };
}
