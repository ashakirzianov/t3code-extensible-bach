/**
 * The handful of constants that describe how the host and an extension
 * recognise each other: the token's subject, what that token may do, and the
 * environment variables the process is handed.
 *
 * They live apart from the registry and the supervisor because `t3 pair`
 * needs them to mint a dev credential, and a CLI command should not have to
 * pull in the HTTP server and the settings service to do it.
 */
// Re-exported rather than defined here: the scope set is part of what an
// extension author needs to know, so it lives with the rest of the protocol
// constants and the generated guide can read it without importing the server.
export { EXTENSION_TOKEN_SCOPES } from "@t3tools/contracts";

/**
 * A connection may only speak for the extension its token was minted for. The
 * supervisor mints subjects as `extension:<name>`; a token paired by hand for
 * dev carries the same shape, which is what makes §6.4's "run the process
 * yourself" work without a second auth concept.
 */
export const EXTENSION_SUBJECT_PREFIX = "extension:";

/** Environment variables the extension reads to find its host and its state. */
export const EXTENSION_ENV = {
  name: "T3_EXT_NAME",
  token: "T3_EXT_TOKEN",
  /** The host's ordinary client socket — the same `/ws` every client uses. */
  url: "T3_EXT_WS_URL",
  dataDir: "T3_EXT_DATA_DIR",
  protocol: "T3_EXT_PROTOCOL_VERSION",
} as const;
