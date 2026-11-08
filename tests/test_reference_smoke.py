"""Real public-domain singing, repeated lines, wrong variants and a muted verse.

Lyrics and independent source captions:
https://commons.wikimedia.org/w/index.php?title=TimedText:Auld_Lang_Syne.ogg.en.srt&oldid=1217335773
The checksum-verified excerpt is original source12-42s; no copyrighted fixtures.
"""

import json
import os
import subprocess
import wave
from dataclasses import asdict, replace
from pathlib import Path

import pytest
from gpu_smoke import gpu_context
from lyrics_fixture import sung_excerpt

from separator import processing
from separator.lyrics_reference import ReferenceLookup, ReferenceReview, reference_lines
from separator.modal_app import TIMEOUT

pytestmark = [pytest.mark.smoke, pytest.mark.timeout(TIMEOUT + 300)]


def test_real_reference_repeats_wrong_variant_and_genuinely_omitted_verse(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Known public-domain words, not provider-echo mocks. Candidate timings
    # still require actual model/audio-derived evidence through the GPU pool.
    canonical = (
        "Should old acquaintance be forgot\nAnd never brought to mind\n"
        "Should old acquaintance be forgot\nAnd days of auld lang syne"
    )
    lrc = (
        "[00:01.00]Should old acquaintance be forgot\n"
        "[00:08.10]And never brought to mind\n"
        "[00:12.60]Should old acquaintance be forgot\n"
        "[00:20.10]And days of auld lang syne\n[00:26.10]"
    )
    review = ReferenceReview(
        "matched",
        "Public-domain audio/caption fixture; not an accuracy guarantee.",
        provider="Wikimedia Commons TimedText (public domain lyrics)",
        source_url="https://commons.wikimedia.org/w/index.php?title=TimedText:Auld_Lang_Syne.ogg.en.srt&oldid=1217335773",
        lines=reference_lines(canonical, lrc, 30),
        provider_timing_status="candidate",
    )
    context = gpu_context(tmp_path / "computed")

    def transcribe(audio: bytes, candidate: ReferenceReview):
        monkeypatch.setattr(
            processing,
            "lookup_reference",
            lambda _metadata, _cache: ReferenceLookup(None, candidate),
        )
        return processing.transcribe_source(audio, context, None)

    source = sung_excerpt()
    result = transcribe(source, review)
    assert result.reference is not None
    assert [line.status for line in result.reference.lines] == ["aligned"] * 4, asdict(
        result.reference
    )
    first, _, repeated, ending = result.reference.lines
    assert first.start_s is not None and first.end_s is not None
    assert repeated.start_s is not None and ending.start_s is not None
    assert 0.5 < first.start_s < 4
    assert 11 < repeated.start_s < 17
    assert 19 < ending.start_s < 25
    assert first.end_s < repeated.start_s
    assert any(
        2 < word.start_s < 6 and word.text == "acquaintance" for word in result.words
    )
    assert all(word.probability is None for word in result.words)
    variants = []
    for replacement in [
        "Crimson planets orbit distant stars",
        "And always brought to mind",
    ]:
        index = 0 if replacement.startswith("Crimson") else 1
        lines = list(review.lines)
        lines[index] = replace(lines[index], text=replacement)
        negative = transcribe(source, replace(review, lines=lines))
        assert negative.reference is not None
        assert negative.reference.lines[index].status == "unconfirmed", asdict(
            negative.reference
        )
        assert negative.reference.lines[index].start_s is None
        assert replacement not in [segment.text for segment in negative.segments]
        variants.append(asdict(negative))
    # The fixture is already mono16k PCM16 in lossless FLAC. Decode and mute
    # exactly samples [0.5s, 8s), retaining the entire original recording clock.
    pcm = bytearray(
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                "pipe:0",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "s16le",
                "pipe:1",
            ],
            input=source,
            capture_output=True,
            check=True,
        ).stdout
    )
    pcm[int(0.5 * 16000) * 2 : 8 * 16000 * 2] = bytes(int(7.5 * 16000) * 2)
    muted = tmp_path / "muted.wav"
    with wave.open(str(muted), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(pcm)
    omitted = transcribe(muted.read_bytes(), review)
    assert omitted.reference is not None
    assert omitted.reference.lines[0].status == "unconfirmed", asdict(omitted.reference)
    assert omitted.reference.lines[0].start_s is None
    assert all(not (0.5 <= word.start_s < 7.8) for word in omitted.words)
    assert any(line.status == "aligned" for line in omitted.reference.lines[2:])
    proof = {
        "original": asdict(result),
        "wrong_variants": variants,
        "omitted": asdict(omitted),
    }
    assert proof["original"]["reference"]["status"] == "aligned"
    evidence = os.environ.get("REFERENCE_EVIDENCE_DIR")
    if evidence:
        directory = Path(evidence)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "reference-controls.json").write_text(json.dumps(proof))
    print("REAL_REFERENCE_NEGATIVE_CONTROLS_PASS")
