/**
 * Identity constants that separate this fork from upstream T3 Code.
 *
 * Upstream already varies each of these between its release and `.dev` builds;
 * the fork is one more variant of the same knobs, so every consumer keeps the
 * shape it already had and only the values move. Collected here so an uptake
 * conflict is a one-file lookup rather than a hunt (see
 * `docs/internals/extensible-fork.md`).
 *
 * Deliberately NOT here: the `t3code://` URL scheme and the T3 home directory,
 * which stay shared with upstream (design §8).
 */

/** Reverse-DNS app id: Launch Services identity, notification attribution, Windows taskbar grouping. */
export const FORK_APP_ID = "com.ashakirzianov.t3code-extensible";
export const FORK_DEV_APP_ID = `${FORK_APP_ID}.dev`;

/**
 * Electron `userData` directory name, under the OS application-support dir.
 *
 * Must differ from upstream's `t3code`: Electron scopes the single-instance
 * lock to this directory and keeps Chromium profile state in it, so sharing it
 * would make the fork and upstream contend for one lock and one profile.
 */
export const FORK_USER_DATA_DIR_NAME = "t3code-extensible";
export const FORK_DEV_USER_DATA_DIR_NAME = "t3code-extensible-dev";

/**
 * The Electron-default, product-name-derived `userData` path that
 * `resolveUserDataPath` treats as a legacy install to migrate from.
 *
 * The fork has no such history, so these names are expected never to exist and
 * the legacy branch never to fire. They must not be upstream's
 * "T3 Code (Alpha)" / "T3 Code (Dev)": those DO exist on an upstream user's
 * machine, and the fork would adopt upstream's profile directory. The values
 * track the fork's display name so the branch stays meaningful if the product
 * name is ever changed to match.
 */
export const FORK_LEGACY_USER_DATA_DIR_NAME = "T3 Code Extensible (Alpha)";
export const FORK_DEV_LEGACY_USER_DATA_DIR_NAME = "T3 Code Extensible (Dev)";

/** Linux desktop-entry filename and WM class, so the fork does not overwrite upstream's launcher entry. */
export const FORK_LINUX_DESKTOP_ENTRY_NAME = "t3code-extensible.desktop";
export const FORK_DEV_LINUX_DESKTOP_ENTRY_NAME = "t3code-extensible-dev.desktop";
export const FORK_LINUX_WM_CLASS = "t3code-extensible";
export const FORK_DEV_LINUX_WM_CLASS = "t3code-extensible-dev";

/**
 * Linux screen-capture identity.
 *
 * The capture feature's runtime app id is **not** the desktop bundle id: it is
 * derived from the Linux desktop entry name (`DesktopSnapShot.ts` strips the
 * `.desktop` suffix), which is the WM-class family, and that is already forked
 * above. What is left here is the things upstream spells out as literals.
 *
 * `FORK_LINUX_HELPER_DIR_NAME` is the directory under XDG data home where the
 * KDE, Hyprland, and GNOME capture helpers install themselves. Upstream uses
 * `t3code`; sharing it would have the fork write its helper binaries and
 * extension backups into upstream's directory.
 *
 * The KDE helper's desktop entry is a separate `NoDisplay` service file, not
 * the app's launcher. Nothing resolves it by name, but both apps write it into
 * the same `~/.local/share/applications`, so the filename has to differ or
 * whichever installed last owns the other's `Exec=`. The marker is how the
 * installer recognises an entry as its own before overwriting it, so it has to
 * move with the filename.
 */
export const FORK_LINUX_HELPER_DIR_NAME = "t3code-extensible";
export const FORK_KDE_CAPTURE_DESKTOP_FILE = `${FORK_APP_ID}.KdeCapture.desktop`;
export const FORK_KDE_CAPTURE_HELPER_MARKER = "X-T3CodeExtensible-Capture-Helper=true";

/**
 * Boot-service base name: the systemd user unit is `<name>.service`, and the
 * launchd label is the app id plus a `.service` suffix (see
 * `apps/server/src/cloud/bootService.ts`). Distinct from upstream's `t3code` so
 * the two apps' installed services do not overwrite each other's unit files,
 * launchd records, or TCC grants.
 */
export const FORK_BOOT_SERVICE_NAME = "t3code-extensible";

/**
 * Default electron-updater publish target, as `owner/repo`.
 *
 * Only a default: `T3CODE_DESKTOP_UPDATE_REPOSITORY` and `GITHUB_REPOSITORY`
 * still win. It exists so a fork build made outside CI cannot fall back to a
 * feed that would update the fork into upstream.
 */
export const FORK_UPDATE_REPOSITORY = "ashakirzianov/t3code-extensible";
