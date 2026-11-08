"""Isolated singing ASR, followed by independently checked reference alignment.

Qwen sees no reference/song identity during recognition. MMS CTC then aligns
candidate text to audio; failed/unsupported alignment never invents timestamps.
"""

# Heavy imports stay within the concrete producers, after cache lookup.
# ruff: noqa: PLC0415
from __future__ import annotations

import math
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

    from separator.align_lyrics import VocalAligner

from separator import cache_versions
from separator.cache_versions import ASR_SAMPLE_RATE as SAMPLE_RATE
from separator.lyrics import (
    RecognitionChunk,
    TranscriptWord,
)
from separator.lyrics_reference import (
    AcousticEvidence,
    ReferencePhrase,
    ReferenceReview,
    counterfactual_line,
    tokens,
)

MODEL = cache_versions.QWEN_MODEL


def _windows(audio: np.ndarray) -> list[tuple[int, int]]:
    """Full-track 25s recognition contexts, with no speech VAD or lyric prompts."""
    size = 25 * SAMPLE_RATE
    return [
        (start, min(len(audio), start + size)) for start in range(0, len(audio), size)
    ]


def _load_audio(source: Path) -> tuple[np.ndarray, int]:
    import librosa  # ty: ignore[unresolved-import]

    return librosa.load(str(source), sr=SAMPLE_RATE, mono=True)


def _load_aligner(model_cache: Path) -> VocalAligner:
    from separator.align_lyrics import VocalAligner

    return VocalAligner(model_cache)


def _recognize_windows(
    audio: np.ndarray,
    sample_rate: int,
    windows: list[tuple[int, int]],
) -> list[RecognitionChunk]:
    import torch  # ty: ignore[unresolved-import]
    from qwen_asr import Qwen3ASRModel  # ty: ignore[unresolved-import]

    model = Qwen3ASRModel.from_pretrained(
        MODEL,
        revision=cache_versions.QWEN_REVISION,
        dtype=torch.bfloat16,
        device_map="cuda:0",
        max_inference_batch_size=2,
        max_new_tokens=512,
    )
    results = model.transcribe(
        audio=[(audio[start:end], sample_rate) for start, end in windows]
    )
    chunks = [
        RecognitionChunk(
            start / sample_rate,
            end / sample_rate,
            start / sample_rate,
            end / sample_rate,
            result.text,
            result.language,
        )
        for (start, end), result in zip(windows, results, strict=True)
    ]
    del model
    torch.cuda.empty_cache()
    return chunks


def align_reference_acoustics(
    audio: np.ndarray,
    aligner: VocalAligner,
    review: ReferenceReview,
    phrases: list[ReferencePhrase],
) -> tuple[dict[int, list[TranscriptWord]], dict[int, AcousticEvidence]]:
    """Measure prepared reference candidates without planning or acceptance."""
    duration_s = len(audio) / SAMPLE_RATE
    aligned_lines = {}
    acoustic_evidence = {}
    previous_candidate_end = 0.0
    for phrase in phrases:
        start = round(phrase.start_s * SAMPLE_RATE)
        end = min(len(audio), round(phrase.end_s * SAMPLE_RATE))
        context_start = start / SAMPLE_RATE
        emission, frame_s = aligner.emissions(audio[start:end])
        canonical_lines = [review.lines[index].text for index in phrase.line_indices]
        candidate = aligner.align(emission, frame_s, phrase.text, context_start)
        if [token for word in candidate for token in tokens(word.text)] != tokens(
            phrase.text
        ):
            continue
        phrase_score = aligner.log_score(emission, phrase.text)
        cursor = 0
        for position, index in enumerate(phrase.line_indices):
            line = review.lines[index]
            count = len(tokens(line.text))
            line_words = candidate[cursor : cursor + count]
            cursor += count
            alternative_text = counterfactual_line(
                line.text,
                phrase.recognized_lines[position],
            )
            if (
                review.provider_timing_status == "validated"
                and line.provider_start_s is not None
                and line.provider_end_s is not None
            ):
                line_words = aligner.search(
                    emission,
                    frame_s,
                    line.text,
                    context_start,
                    max(previous_candidate_end, line.provider_start_s - 0.75),
                    min(duration_s, line.provider_end_s + 0.75),
                )
                if len(line_words) != count:
                    continue
                # The acoustic model still sees the complete 20-30s phrase.
                # Compare both hypotheses on the SAME measured phone-frame
                # interval, never target-word/character-normalized scores.
                score_start = max(context_start, line_words[0].start_s - 0.15)
                score_end = min(end / SAMPLE_RATE, line_words[-1].end_s + 0.15)
                first = max(0, round((score_start - context_start) / frame_s))
                last = min(
                    emission.shape[0], round((score_end - context_start) / frame_s)
                )
                scored = emission[first:last]
                canonical_score = aligner.log_score(scored, line.text)
                alternative_score = aligner.log_score(scored, alternative_text)
                frame_count = last - first
            else:
                canonical_score = phrase_score
                alternative = list(canonical_lines)
                alternative[position] = alternative_text
                alternative_score = aligner.log_score(emission, "\n".join(alternative))
                frame_count = emission.shape[0]
                score_start, score_end = context_start, end / SAMPLE_RATE
            if len(line_words) != count:
                continue
            aligned_lines[index] = line_words
            previous_candidate_end = line_words[-1].end_s
            if math.isfinite(canonical_score) and math.isfinite(alternative_score):
                acoustic_evidence[index] = AcousticEvidence(
                    canonical_score,
                    alternative_score,
                    phrase.recognized_lines[position],
                    frame_count,
                    alternative_text,
                    score_start,
                    score_end,
                )
    return aligned_lines, acoustic_evidence
