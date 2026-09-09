#!/usr/bin/env bash
#
# Build T3 Code as a production macOS app — with whatever extensions you name
# shipped inside it — and leave it, verified, in release/staged.
#
# IT DOES NOT INSTALL, and it never asks for a password. Installing to
# /Applications needs rights this account should not be given, and this script
# is the wrong thing to hand them to: it runs `node`, `vp`, and every
# postinstall script in the dependency tree. The install is
# scripts/copy-desktop-app.sh — four lines, no arguments — run as an admin:
#
#   su <admin> -c /path/to/t3code-extensible/scripts/copy-desktop-app.sh
#
# The split is the point: everything that needs thinking about happens here,
# unprivileged, and the elevated half is short enough to read in full.
#
# WHY IT TAKES --extension AND NOT A HARDCODED LIST. A shipped extension is just
# a folder the desktop names with `--extension name=path` (design §6.2); the
# word "bundled" appears nowhere in the server. So this script takes the same
# shape the product does, and an ordinary build ships nothing.
#
# WHAT IT VERIFIES THAT THE ARTIFACT BUILDER DOES NOT: that each extension you
# named actually arrived in the bundle, byte-identical. A build where
# T3CODE_BUNDLED_EXTENSIONS never reached electron-builder succeeds, produces a
# perfectly good app, and ships no extension at all — measured 2026-09-09, and
# the reason that check exists.
#
# WHAT IT DOES NOT VERIFY, and you should read this before calling a green run a
# success:
#   - that the staged app LAUNCHES, or that anything works from it
#   - that extensions spawn, or that their tools reach an agent
#   - code signing / notarization (unsigned unless --signed; Gatekeeper may
#     quarantine a fresh unsigned bundle on first launch)
#
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# THE FIXED HANDOFF POINT between this script and scripts/copy-desktop-app.sh.
# Fixed, not configurable: the copy script runs with another account's rights,
# so its source path is a literal you can read once and trust forever.
readonly STAGE_DIR="$REPO_ROOT/release/staged"
readonly APP_DIR="/Applications"
readonly EXPECTED_APP_NAME="T3 Code (Alpha).app"
readonly STARTED_AT_EPOCH="$(date +%s)"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"

ARCH_FLAG="$(uname -m)"
SKIP_BUILD=0
KEEP_EXTRACT=0
PASSTHROUGH=()
EXT_NAMES=()
EXT_PATHS=()

die() { printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32mok\033[0m  %s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: scripts/build-desktop-app.sh [options]

Builds and verifies a production macOS .app, leaving it at release/staged/.
It does NOT install anything and never asks for a password. To put the built
app in /Applications, run the other script as an account that can write there:

  su <admin> -c /path/to/t3code-extensible/scripts/copy-desktop-app.sh

Options:
  --extension <name=path>  Ship a built extension folder inside the app.
                           Repeatable. The path must exist and contain
                           extension.json. Default: none.
  --skip-build             Use the artifacts already in release/ instead of
                           rebuilding. The freshness check still applies, so it
                           refuses a zip older than the newest source file
                           rather than quietly staging yesterday's build.
  --arch <arm64|x64>       Defaults to this machine's arch.
  --signed                 Pass --signed through to the artifact builder.
  --keep-extract           Leave the intermediate extraction in release/.
  --help

QUIT THE APP FIRST if one is already installed — the copy step replaces the
bundle a running app is executing from.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension)
      shift; [[ $# -gt 0 ]] || die "--extension needs name=path"
      case "$1" in
        *=*) : ;;
        *) die "--extension takes name=path, got '$1'" ;;
      esac
      EXT_NAMES+=("${1%%=*}")
      EXT_PATHS+=("${1#*=}")
      ;;
    --skip-build) SKIP_BUILD=1 ;;
    --arch) shift; [[ $# -gt 0 ]] || die "--arch needs a value"; ARCH_FLAG="$1" ;;
    --signed) PASSTHROUGH+=("--signed") ;;
    --keep-extract) KEEP_EXTRACT=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
step "Preflight"
[[ "$(uname -s)" == "Darwin" ]] || die "macOS only; this builds a .app bundle"
command -v node >/dev/null || die "node not on PATH"
[[ -f "$REPO_ROOT/scripts/build-desktop-artifact.ts" ]] \
  || die "not the repo root: $REPO_ROOT"
ok "macOS, arch=$ARCH_FLAG, repo=$REPO_ROOT"

# NO WRITABILITY CHECK ON /Applications, deliberately. This script never writes
# there and never elevates. The copy script is the one that needs those rights,
# and it is four lines long so you can read all of it before typing one.

# Which commit is about to become the app. Printed rather than checked: a green
# run should tell you WHAT it built, so a surprise later has an answer that does
# not need a guess.
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  ok "building $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD) @ $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    ok "NOTE: working tree is dirty — the build includes uncommitted changes"
  fi
fi

# EXTENSIONS ARE VALIDATED BEFORE THE BUILD, not after it. A bad path here costs
# a minute of build time to discover otherwise, and the artifact builder's own
# error arrives deep inside a staging step.
BUNDLED_ENV=""
if [[ "${#EXT_NAMES[@]}" -gt 0 ]]; then
  for i in "${!EXT_NAMES[@]}"; do
    name="${EXT_NAMES[$i]}"
    path="${EXT_PATHS[$i]}"
    [[ -n "$name" && -n "$path" ]] || die "--extension takes name=path, got an empty half"
    [[ -d "$path" ]] || die "extension '$name': $path is not a directory"
    [[ -f "$path/extension.json" ]] \
      || die "extension '$name': $path has no extension.json — is it a built folder, not a source checkout?"
    # Absolute, so the value does not depend on where the artifact builder runs.
    abs="$(cd "$path" && pwd)"
    EXT_PATHS[$i]="$abs"
    BUNDLED_ENV="${BUNDLED_ENV:+$BUNDLED_ENV,}$name=$abs"
    ok "extension $name <- $abs"
  done
else
  ok "no extensions requested; this build ships none"
fi

# ---------------------------------------------------------------------------
step "Build"
cd "$REPO_ROOT"

# `build-desktop-artifact.ts` spawns `vp` via ChildProcess, inheriting OUR PATH
# and bypassing any package-manager shim. `vp` lives in node_modules/.bin, so in
# a plain Terminal it is simply absent and the build dies with `spawn vp ENOENT`.
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"
command -v vp >/dev/null 2>&1 \
  || die "vp not on PATH even after adding node_modules/.bin — run 'pnpm install' first"

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  ok "skipping build by request"
else
  # macOS ships bash 3.2, where "${ARR[@]}" on an EMPTY array is an unbound
  # variable error under `set -u`. ${ARR[@]+"${ARR[@]}"} is the 3.2-safe idiom.
  T3CODE_BUNDLED_EXTENSIONS="$BUNDLED_ENV" \
    node scripts/build-desktop-artifact.ts \
      --platform mac --target dmg --arch "$ARCH_FLAG" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} \
    || die "artifact build failed"
fi

# ---------------------------------------------------------------------------
step "Locating the artifact"

# NEWEST zip, not "first one find returns". release/ accumulates builds across
# versions, and directory order is not time order.
BUILT_ZIP="$(ls -t "$REPO_ROOT"/release/*.zip 2>/dev/null | head -1 || true)"
[[ -n "$BUILT_ZIP" ]] || die "no .zip under $REPO_ROOT/release — the build produced nothing installable"
ok "artifact: $(basename "$BUILT_ZIP")"

ZIP_EPOCH="$(stat -f %m "$BUILT_ZIP")"
if [[ "$SKIP_BUILD" -eq 1 ]]; then
  # Nothing was built this run, so "newer than the run" cannot be the test.
  # An artifact older than the code it is supposed to contain is the exact
  # mistake --skip-build invites.
  NEWEST_SRC="$(find "$REPO_ROOT/apps" "$REPO_ROOT/packages" -type f \
    \( -name '*.ts' -o -name '*.tsx' \) -newer "$BUILT_ZIP" -print -quit 2>/dev/null || true)"
  [[ -z "$NEWEST_SRC" ]] \
    || die "$(basename "$BUILT_ZIP") is older than $NEWEST_SRC — rebuild instead of --skip-build"
  ok "artifact is newer than every source file"
else
  [[ "$ZIP_EPOCH" -ge "$STARTED_AT_EPOCH" ]] \
    || die "$(basename "$BUILT_ZIP") predates this run — the build did not produce it"
  ok "artifact was produced by this run"
fi

# ---------------------------------------------------------------------------
step "Extracting"

# A FRESH DIRECTORY EVERY RUN, removed on exit unless --keep-extract. Leftovers
# are what let an older script discover a day-old bundle on its next run.
EXTRACT_DIR="$REPO_ROOT/release/.extract-$STAMP"
cleanup() {
  if [[ "$KEEP_EXTRACT" -eq 0 && -d "$EXTRACT_DIR" ]]; then
    rm -rf "$EXTRACT_DIR"
  fi
}
trap cleanup EXIT INT TERM

rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
# `ditto -x -k` rather than `unzip`: it preserves the resource forks, symlinks
# and extended attributes an .app bundle needs to stay launchable.
ditto -x -k "$BUILT_ZIP" "$EXTRACT_DIR" || die "failed to extract $BUILT_ZIP"

BUILT_APP="$(find "$EXTRACT_DIR" -maxdepth 2 -name '*.app' -type d -print -quit 2>/dev/null || true)"
[[ -n "$BUILT_APP" ]] || die "no .app inside $(basename "$BUILT_ZIP") after extraction"
ok "extracted: $(basename "$BUILT_APP")"

# ---------------------------------------------------------------------------
step "Verifying the bundle"

# PATH-ANCHORED. A bare `-name bin.mjs` under Contents/Resources also matches
# `node_modules/yaml/bin.mjs`, which ships in every build and says nothing about
# whether the server is in there.
#
# The server may sit either in app.asar.unpacked (a real file) or inside
# app.asar itself. The asar case reads the archive's JSON header directly rather
# than pulling in @electron/asar: the header is the archive's directory, so a
# path present there is a file the app can load.
find_server_bundle() {
  local resources="$1/Contents/Resources"
  find "$resources" -path '*/apps/server/dist/bin.mjs' -print -quit 2>/dev/null | grep -q . && {
    echo "unpacked"
    return 0
  }
  [[ -f "$resources/app.asar" ]] || return 1
  node - "$resources/app.asar" <<'NODE'
const fs = require("node:fs");
const fd = fs.openSync(process.argv[2], "r");
const pickle = Buffer.alloc(16);
fs.readSync(fd, pickle, 0, 16, 0);
const headerSize = pickle.readUInt32LE(12);
const header = Buffer.alloc(headerSize);
fs.readSync(fd, header, 0, headerSize, 16);
const files = JSON.parse(header.toString("utf8"));
const bin = files.files?.apps?.files?.server?.files?.dist?.files?.["bin.mjs"];
if (!bin) process.exit(1);
console.log("in app.asar");
NODE
}
SERVER_BUNDLE_LOCATION="$(find_server_bundle "$BUILT_APP" || true)"
[[ -n "$SERVER_BUNDLE_LOCATION" ]] \
  || die "no server bundle inside the .app (checked app.asar.unpacked and the app.asar header) — it would have no backend"
ok "server bundle present ($SERVER_BUNDLE_LOCATION)"

# THE CHECK THIS SCRIPT EXISTS FOR. Each extension must be in the bundle, beside
# app.asar rather than inside it (a path inside an asar cannot be a process cwd,
# and the server spawns each extension in its own folder), and byte-identical to
# what was asked for.
if [[ "${#EXT_NAMES[@]}" -gt 0 ]]; then
  for i in "${!EXT_NAMES[@]}"; do
    name="${EXT_NAMES[$i]}"
    shipped="$BUILT_APP/Contents/Resources/extensions/$name"
    [[ -d "$shipped" ]] \
      || die "extension '$name' is NOT in the built app. The build succeeded and shipped nothing: check that T3CODE_BUNDLED_EXTENSIONS reached electron-builder."
    [[ -f "$shipped/extension.json" ]] || die "extension '$name' shipped without its extension.json"
    diff -r "${EXT_PATHS[$i]}" "$shipped" >/dev/null \
      || die "extension '$name' in the bundle differs from ${EXT_PATHS[$i]}"
    ok "extension $name shipped, byte-identical"
  done
fi

# PATHS STRIPPED AND HASHES SORTED, both load-bearing. `shasum` prints
# "hash  path", and the built and staged paths necessarily differ, so a digest
# over raw output would differ on every run. Sorting removes the other trap:
# find order is not guaranteed to match between two directories.
bundle_digest() {
  find "$1" -type f -exec shasum -a 256 {} + | awk '{print $1}' | sort | shasum -a 256 | awk '{print $1}'
}
BUILT_SUM="$(bundle_digest "$BUILT_APP")"
ok "bundle checksum ${BUILT_SUM:0:16}…"

# ---------------------------------------------------------------------------
step "Staging"
APP_NAME="$(basename "$BUILT_APP")"
TARGET="$STAGE_DIR/$APP_NAME"

# EMPTIED, NOT MERGED INTO. cp -R over an existing bundle merges, so a file
# deleted between builds would survive in the staged copy.
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -R "$BUILT_APP" "$TARGET" || die "staging copy failed"

# Prove what is on disk is what was just built, rather than trusting cp. This
# runs HERE and not in the copy script on purpose: verification belongs on the
# unprivileged side, so the elevated script stays four readable lines.
STAGED_SUM="$(bundle_digest "$TARGET")"
[[ "$STAGED_SUM" == "$BUILT_SUM" ]] \
  || die "staged bundle differs from the built one ($STAGED_SUM != $BUILT_SUM)"
ok "staged bundle is byte-identical to the built one"

# A glob inside [[ ]] is NOT expanded, so this asks `find`. The obvious form
# silently tests a literal string and can never fail.
find "$TARGET/Contents/MacOS" -type f -perm -u+x -print -quit 2>/dev/null | grep -q . \
  || die "no executable in $TARGET/Contents/MacOS — the bundle will not launch"
ok "an executable is present in Contents/MacOS"

# The copy script hard-codes this name. If a rename ever ships, that script
# copies a path that no longer exists — better to say so now than to have the
# elevated step fail with a bare `cp: No such file or directory`.
[[ "$APP_NAME" == "$EXPECTED_APP_NAME" ]] \
  || die "built app is named '$APP_NAME', but scripts/copy-desktop-app.sh expects
    '$EXPECTED_APP_NAME'. Update that script's two literal paths to match."

# ---------------------------------------------------------------------------
step "Done"
cat <<EOF

  Staged: $TARGET

  NOT INSTALLED YET. Nothing has touched $APP_DIR. To install it there for
  every user on this machine, run the copy script as an account that can
  write $APP_DIR — it takes no arguments and is four lines long:

    su <admin> -c $REPO_ROOT/scripts/copy-desktop-app.sh

  STILL UNPROVEN — nothing here started the app:
    - that it launches
    - that its extensions spawn and their tools reach an agent
    - signing: an unsigned build may be Gatekeeper-quarantined on first launch

EOF
