#!/usr/bin/env bash
set -euo pipefail

readonly libkeyfinder_commit=b33b5a88e04a5182dd19c38c57762925631118fd
readonly libkeyfinder_sha256=6b9243c5c0c47ad9a66073c8caf41b1cd41fcf4e71f7231921a6ac3f797eac80
readonly keyfinder_cli_commit=4ca2934cbc72688d4da658645bb6c2170a58f9bb
readonly keyfinder_cli_sha256=201c50a27215622dc23770052c9a1094260680475a6e0e1781ccc60a0233a905
readonly prefix="${PREFIX:-/usr/local}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fetch_checked() {
  local repository="$1" commit="$2" checksum="$3" archive="$4"
  curl --fail --location --silent --show-error \
    "https://codeload.github.com/${repository}/tar.gz/${commit}" \
    --output "$archive"
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
}

mkdir "$tmpdir/libkeyfinder" "$tmpdir/keyfinder-cli"
fetch_checked mixxxdj/libkeyfinder "$libkeyfinder_commit" "$libkeyfinder_sha256" "$tmpdir/libkeyfinder.tar.gz"
fetch_checked evanpurkhiser/keyfinder-cli "$keyfinder_cli_commit" "$keyfinder_cli_sha256" "$tmpdir/keyfinder-cli.tar.gz"
tar -xzf "$tmpdir/libkeyfinder.tar.gz" -C "$tmpdir/libkeyfinder" --strip-components=1
tar -xzf "$tmpdir/keyfinder-cli.tar.gz" -C "$tmpdir/keyfinder-cli" --strip-components=1
# FFmpeg <=6 exposes channel_layout as a bitmask, not a channel count.
# Passing stereo's mask (3) as its count (2) shifts decoded pitch by 3/2.
# Keep this exact source correction beside the verified upstream pins so CI
# and Docker use the same decoder; fail rather than silently accepting drift.
patch --directory="$tmpdir/keyfinder-cli" --strip=1 --batch --forward --fuzz=0 <<'PATCH'
--- a/keyfinder_cli.cpp
+++ b/keyfinder_cli.cpp
@@ -173,7 +173,7 @@
 #if LIBAVFORMAT_VERSION_MAJOR > 60
     audio.setChannels(codec_context->ch_layout.nb_channels);
 #else
-    audio.setChannels(codec_context->channel_layout);
+    audio.setChannels(codec_context->channels);
 #endif
 
     SafeAVPacket packet;
PATCH
cmake -S "$tmpdir/libkeyfinder" -B "$tmpdir/libkeyfinder/build" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_INSTALL_LIBDIR=lib
cmake --build "$tmpdir/libkeyfinder/build" --parallel 2
cmake --install "$tmpdir/libkeyfinder/build"
make -C "$tmpdir/keyfinder-cli" CXX="${CXX:-g++} -L${prefix}/lib"
install -m 755 "$tmpdir/keyfinder-cli/keyfinder-cli" "$prefix/bin/keyfinder-cli"
strip "$prefix/bin/keyfinder-cli"
