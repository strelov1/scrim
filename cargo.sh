#!/bin/sh
# cargo with a repo-local CARGO_HOME and an empty environment, so a build depends on nothing
# outside this checkout. MACOSX_DEPLOYMENT_TARGET=14.0 is required: the prebuilt librusty_v8.a
# uses chained fixups, and an older target fails to link.
#
# RUSTY_V8_ARCHIVE points the v8 crate at an already-downloaded librusty_v8.a (rusty_v8 v150.4.0)
# so the build makes no network call. It is kept outside target/ because the v8 build script
# copies it into target/ and must never read and write the same file. Without that file the
# crate downloads its own copy (~147 MB), which also works.
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
archive="$root/.cargo-home/rusty_v8/librusty_v8.a"
[ -f "$archive" ] || archive=""

exec env -i HOME="$HOME" PATH="$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin" RUSTUP_HOME="$HOME/.rustup" \
  CARGO_HOME="$root/.cargo-home" \
  ${archive:+RUSTY_V8_ARCHIVE="$archive"} \
  MACOSX_DEPLOYMENT_TARGET=14.0 cargo "$@"
