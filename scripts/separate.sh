#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <filename>" >&2
    exit 1
fi

input="$1"

if [[ ! -f "$input" ]]; then
    echo "Error: file not found: $input" >&2
    exit 1
fi

cd "$(dirname "$0")/.."

base="$(basename "${input%.*}")"

echo ">> Separating vocals -> ./acapella"
audio-separator "$input" --model_filename vocals_mel_band_roformer.ckpt --output_format MP3 --output_dir ./acapella
for f in ./acapella/"${base}"_\(*\)_vocals_mel_band_roformer.mp3; do
    if [[ -f "$f" && "$f" != *"_(vocals)_"* ]]; then
        echo ">> Removing leftover stem: $f"
        rm -f "$f"
    fi
done

echo ">> Separating instrumental -> ./instrumental"
audio-separator "$input" --model_filename melband_roformer_inst_v2.ckpt --output_format MP3 --output_dir ./instrumental
for f in ./instrumental/"${base}"_\(*\)_melband_roformer_inst_v2.mp3; do
    if [[ -f "$f" && "$f" != *"_(Instrumental)_"* ]]; then
        echo ">> Removing leftover stem: $f"
        rm -f "$f"
    fi
done
