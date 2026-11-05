"""Real public-domain singing, repeated lines, wrong variants and a muted verse.

Lyrics and independent source captions:
https://commons.wikimedia.org/w/index.php?title=TimedText:Auld_Lang_Syne.ogg.en.srt&oldid=1217335773
The checksum-verified excerpt is original source12-42s; no copyrighted fixtures.
"""

import json
import os
from pathlib import Path

import modal
import pytest
from lyrics_fixture import sung_excerpt

from backend import config
from separator.modal_app import (
    ASR_PYTHON,
    GPU,
    MODEL_CACHE,
    MODEL_VOLUME_NAME,
    TIMEOUT,
    image,
)

pytestmark = [pytest.mark.smoke, pytest.mark.timeout(TIMEOUT + 300)]
model_volume = modal.Volume.from_name(
    MODEL_VOLUME_NAME, environment_name=config.MODAL_ENVIRONMENT
)


def test_real_reference_repeats_wrong_variant_and_genuinely_omitted_verse() -> None:
    assert config.MODAL_APP_NAME != "audio-separator", "Use an isolated test app"
    # Known public-domain words, not provider-echo mocks. Times below are only
    # candidate priors; the assertions concern real model/audio-derived spans.
    script = r"""
import json
from dataclasses import asdict, replace
from pathlib import Path
import librosa
import soundfile as sf
from separator.align_lyrics import VocalAligner
from separator.lyrics import Transcript
from separator.lyrics_reference import ReferenceReview, reference_lines
from separator.transcribe import align_reference_audio, transcribe
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
    "matched", "Public-domain audio/caption fixture; not an accuracy guarantee.",
    provider="Wikimedia Commons TimedText (public domain lyrics)",
    source_url="https://commons.wikimedia.org/w/index.php?title=TimedText:Auld_Lang_Syne.ogg.en.srt&oldid=1217335773",
    lines=reference_lines(canonical, lrc, 30), provider_timing_status="candidate",
)
cache = Path(MODEL_CACHE) / "qwen-asr"
source = Path('/tmp/sung.flac')
result = transcribe(source, cache, review)
assert result.reference is not None
assert [line.status for line in result.reference.lines] == ["aligned"] * 4, (
    asdict(result.reference)
)
first, _, repeated, ending = result.reference.lines
assert 0.5 < first.start_s < 4
assert 11 < repeated.start_s < 17
assert 19 < ending.start_s < 25
assert first.end_s < repeated.start_s
assert any(
    2 < word.start_s < 6 and word.text == "acquaintance" for word in result.words
)
assert all(word.probability is None for word in result.words)
audio, sr = librosa.load(str(source), sr=16000, mono=True)
original = Transcript(
    segments=result.reference.original_segments,
    words=result.reference.original_words, language=result.language,
    recognition_chunks=result.recognition_chunks,
    untimed=result.reference.original_untimed,
    asr_model=result.asr_model, word_alignment=result.word_alignment,
)
aligner = VocalAligner(cache)
variants = []
for replacement in [
    "Crimson planets orbit distant stars", "And always brought to mind",
]:
    index = 0 if replacement.startswith("Crimson") else 1
    lines = list(review.lines)
    lines[index] = replace(lines[index], text=replacement)
    negative = align_reference_audio(original, audio, aligner,
        replace(review, lines=lines), original.words)
    assert negative.reference.lines[index].status == "unconfirmed", (
        asdict(negative.reference)
    )
    assert negative.reference.lines[index].start_s is None
    assert replacement not in [segment.text for segment in negative.segments]
    variants.append(asdict(negative))
# Preserve recording duration/clock while genuinely removing the first verse.
# This is changed audio, not a test that merely asks a mock to omit words.
muted = audio.copy()
muted[int(.5 * sr):int(8.0 * sr)] = 0
sf.write('/tmp/muted.wav', muted, sr)
omitted = transcribe(Path('/tmp/muted.wav'), cache, review)
assert omitted.reference.lines[0].status == "unconfirmed", asdict(omitted.reference)
assert omitted.reference.lines[0].start_s is None
assert all(not (0.5 <= word.start_s < 7.8) for word in omitted.words)
assert any(line.status == "aligned" for line in omitted.reference.lines[2:])
Path('/tmp/reference-proof.json').write_text(json.dumps(dict(
    original=asdict(result), wrong_variants=variants, omitted=asdict(omitted),
), ensure_ascii=False, allow_nan=False))
print('REAL_REFERENCE_NEGATIVE_CONTROLS_PASS')
""".replace("Path(MODEL_CACHE)", f"Path({MODEL_CACHE!r})")
    sandbox = modal.Sandbox.create(
        "sleep",
        str(TIMEOUT),
        app=modal.App.lookup(
            config.MODAL_APP_NAME, environment_name=config.MODAL_ENVIRONMENT
        ),
        image=image,
        gpu=GPU,
        volumes={MODEL_CACHE: model_volume},
        timeout=TIMEOUT,
        workdir="/root",
    )
    try:
        sandbox.filesystem.write_bytes(sung_excerpt(), "/tmp/sung.flac")
        process = sandbox.exec(ASR_PYTHON, "-c", script, timeout=TIMEOUT)
        stdout, stderr = process.stdout.read(), process.stderr.read()
        process.wait()
        assert process.returncode == 0, stderr
        proof = json.loads(sandbox.filesystem.read_text("/tmp/reference-proof.json"))
        assert proof["original"]["reference"]["status"] == "aligned"
        evidence = os.environ.get("REFERENCE_EVIDENCE_DIR")
        if evidence:
            directory = Path(evidence)
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "reference-controls.json").write_text(json.dumps(proof))
        print(stdout)
    finally:
        sandbox.terminate()
