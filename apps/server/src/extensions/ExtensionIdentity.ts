/**
 * The handful of constants that describe how the host and an extension
 * recognise each other: the token's subject, what that token may do, and the
 * environment variables the process is handed.
 *
 * They live apart from the registry and the supervisor because `t3 pair`
 * needs them to mint a dev credential, and a CLI command should not have to
 * pull in the HTTP server and the settings service to do it.
 */
import {
  AuthExtensionScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";

/**
 * A connection may only speak for the extension its token was minted for. The
 * supervisor mints subjects as `extension:<name>`; a token paired by hand for
 * dev carries the same shape, which is what makes §6.4's "run the process
 * yourself" work without a second auth concept.
 */
export const EXTENSION_SUBJECT_PREFIX = "extension:";

/**
 * What an extension's token may do. The orchestration scopes are the ones an
 * extension actually uses — dispatching commands and reading threads. Terminal,
 * review, and relay are deliberately withheld: nothing in the design needs
 * them, and a token is easier to widen later than to narrow.
 */
export const EXTENSION_TOKEN_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthExtensionScope,
] as const;

/** Environment variables the extension reads to find its host and its state. */
export const EXTENSION_ENV = {
  name: "T3_EXT_NAME",
  token: "T3_EXT_TOKEN",
  /** The host's ordinary client socket — the same `/ws` every client uses. */
  url: "T3_EXT_WS_URL",
  dataDir: "T3_EXT_DATA_DIR",
  protocol: "T3_EXT_PROTOCOL_VERSION",
} as const;
