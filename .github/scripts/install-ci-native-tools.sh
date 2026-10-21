#!/usr/bin/env bash
set -euo pipefail

# Build against this host's FFmpeg ABI; the shared script owns the verified
# upstream source pins used by both CI and the production Docker image.
packages=(
  build-essential cmake pkg-config curl ca-certificates libfftw3-dev
  libavcodec-dev libavformat-dev libavutil-dev libswresample-dev
  ffmpeg rubberband-cli libfftw3-double3
)
if (( EUID == 0 )); then
  apt-get update
  apt-get install -y --no-install-recommends "${packages[@]}"
  .github/scripts/build-keyfinder.sh
else
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "${packages[@]}"
  sudo .github/scripts/build-keyfinder.sh
fi

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
