#!/bin/sh
#
# Install the staged app into /Applications, replacing whatever is there.
#
# THIS IS THE ONLY PART THAT RUNS WITH ANOTHER ACCOUNT'S RIGHTS, which is why it
# is its own file, takes no arguments, and is four lines long. Run it as someone
# who can write /Applications:
#
#   su <admin> -c /path/to/t3code-extensible/scripts/copy-desktop-app.sh
#
# Build first, as your normal account: scripts/build-desktop-app.sh. That script
# does the thinking — freshness check, extraction, checksum, "is there actually
# a server bundle in here", and "did the extensions I asked for arrive" — and
# leaves the result at release/staged/. None of it runs elevated, and none of it
# needs to.
#
# NO ARGUMENTS, ON PURPOSE. A path parameter would mean what lands in
# /Applications depends on what you typed at the prompt. Both paths below are
# literals: read them once and you know what this can ever do.
#
# QUIT THE APP FIRST. Replacing a bundle a running process is executing from
# leaves it on deleted inodes — it keeps working until it next reads from disk,
# then fails in ways that look like corruption.
#
set -eu

cd "$(dirname "$0")/.."
rm -rf "/Applications/T3 Code (Alpha).app"
cp -R "release/staged/T3 Code (Alpha).app" "/Applications/T3 Code (Alpha).app"
