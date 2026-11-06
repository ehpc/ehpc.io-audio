#!/usr/bin/env bash
set -euo pipefail

# Avoid the inherited slow Azure archive route without changing Ubuntu suites,
# components, signing keys, security repositories or third-party repositories.
privileged=()
if (( EUID != 0 )); then
  privileged=(sudo)
fi
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources /etc/apt/apt-mirrors.txt; do
  [[ -f "$source" ]] || continue
  grep -qE 'http://azure\.archive\.ubuntu\.com/ubuntu/?([[:space:]]|$)' "$source" || continue
  "${privileged[@]}" sed -i -E \
    's#http://azure\.archive\.ubuntu\.com/ubuntu(/?)([[:space:]]|$)#https://archive.ubuntu.com/ubuntu\1\2#g' \
    "$source"
done

# Build against this host's FFmpeg ABI; the shared script owns the verified
# upstream source pins used by both CI and the production Docker image.
packages=(
  build-essential cmake pkg-config patch curl ca-certificates libfftw3-dev
  libavcodec-dev libavformat-dev libavutil-dev libswresample-dev
  ffmpeg rubberband-cli libfftw3-double3
)
"${privileged[@]}" apt-get update
"${privileged[@]}" apt-get install -y --no-install-recommends "${packages[@]}"
"${privileged[@]}" .github/scripts/build-keyfinder.sh

for tool in ffmpeg ffprobe rubberband keyfinder-cli; do
  command -v "$tool" >/dev/null || {
    echo "Required native audio tool is unavailable: $tool" >&2
    exit 1
  }
done
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=44100:cl=stereo \
  -t 1 -y "$tmpdir/silence.wav"
keyfinder-cli -n standard "$tmpdir/silence.wav" >/dev/null
