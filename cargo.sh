#!/bin/sh
# Run cargo with a repo-local CARGO_HOME and a controlled environment. Use the caller's PATH
# as a fallback when the fixed tool paths contain no cargo.
# MACOSX_DEPLOYMENT_TARGET=14.0 is required because the prebuilt librusty_v8.a uses chained
# fixups, and an older target fails to link.
#
# RUSTY_V8_ARCHIVE points the v8 crate at an already-downloaded librusty_v8.a (rusty_v8 v150.4.0)
# so the build makes no network call. It is kept outside target/ because the v8 build script
# copies it into target/ and must never read and write the same file. Without that file the
# crate downloads its own copy (~147 MB), which also works.
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
archive="$root/.cargo-home/rusty_v8/librusty_v8.a"
[ -f "$archive" ] || archive=""

tool_path="$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin"
(PATH="$tool_path"; command -v cargo >/dev/null 2>&1) || tool_path="$tool_path${PATH:+:$PATH}"

exec env -i HOME="$HOME" PATH="$tool_path" RUSTUP_HOME="$HOME/.rustup" \
  CARGO_HOME="$root/.cargo-home" \
  ${archive:+RUSTY_V8_ARCHIVE="$archive"} \
  MACOSX_DEPLOYMENT_TARGET=14.0 cargo "$@"
