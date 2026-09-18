/**
 * Fork note: the derivation itself lives in `@t3tools/shared/projectIcon`.
 *
 * The server answers `extensions.projectIcons` with the same automatic icon,
 * so an extension draws what the sidebar draws. One copy is what stops the two
 * drifting; this module stays as the web's import path for it.
 */
export { deriveProjectIdentity, type ProjectIdentity } from "@t3tools/shared/projectIcon";
