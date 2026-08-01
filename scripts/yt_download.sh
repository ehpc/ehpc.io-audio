#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
    echo "usage: $(basename "$0") <url> [output_dir]" >&2
    exit 1
fi

url=$1
out=${2:-"$(dirname "$0")/original"}
mkdir -p "$out"

yt-dlp \
    -f 'bestaudio/best' \
    -x --audio-format mp3 --audio-quality 0 \
    -o "$out/%(title)s.%(ext)s" \
    "$url"
