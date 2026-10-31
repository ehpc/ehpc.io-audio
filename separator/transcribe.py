"""Isolated singing ASR, followed by independently checked reference alignment.

Qwen sees no reference/song identity during recognition. MMS CTC then aligns
candidate text to audio; failed/unsupported alignment never invents timestamps.
"""

import json
import math
import os
import sys
from dataclasses import asdict, replace
from pathlib import Path

import librosa  # ty: ignore[unresolved-import]
import numpy as np  # ty: ignore[unresolved-import]
import torch  # ty: ignore[unresolved-import]
from qwen_asr import Qwen3ASRModel  # ty: ignore[unresolved-import]

from separator.align_lyrics import MODEL as ALIGNER_MODEL
from separator.align_lyrics import SAMPLE_RATE, VocalAligner
from separator.lyrics import (
    RecognitionChunk,
    Transcript,
    TranscriptWord,
    recognition_transcript,
)
from separator.lyrics_reference import (
    AcousticEvidence,
    ReferenceReview,
    apply_reference,
    counterfactual_line,
    plan_reference,
    reference_review_from_dict,
    tokens,
)

MODEL = "Qwen/Qwen3-ASR-1.7B"
_MIN_ACOUSTIC_SCORE = 0.03


def _windows(audio: np.ndarray) -> list[tuple[int, int]]:
    """Full-track 25s recognition contexts, with no speech VAD or lyric prompts."""
    size = 25 * SAMPLE_RATE
    return [
        (start, min(len(audio), start + size)) for start in range(0, len(audio), size)
    ]


def transcribe(
    source: Path, model_cache: Path, review: ReferenceReview | None = None
) -> Transcript:
    os.environ["HF_HOME"] = str(model_cache / "huggingface")
    audio, sample_rate = librosa.load(str(source), sr=SAMPLE_RATE, mono=True)
    duration_s = len(audio) / sample_rate
    if not math.isfinite(duration_s) or duration_s <= 0:
        raise ValueError("Lyrics extraction requires audio with a finite duration")
    model = Qwen3ASRModel.from_pretrained(
        MODEL,
        dtype=torch.bfloat16,
        device_map="cuda:0",
        max_inference_batch_size=2,
        max_new_tokens=512,
    )
    windows = _windows(audio)
    contexts = windows
    results = model.transcribe(
        audio=[(audio[start:end], sample_rate) for start, end in contexts]
    )
    # The recognizer's allocations are not needed during acoustic alignment.
    del model
    torch.cuda.empty_cache()
    aligner = VocalAligner(model_cache)
    chunks = []
    alignments = []
    for (core_start, core_end), (start, end), result in zip(
        windows, contexts, results, strict=True
    ):
        chunks.append(
            RecognitionChunk(
                start / sample_rate,
                end / sample_rate,
                core_start / sample_rate,
                core_end / sample_rate,
                result.text,
                result.language,
            )
        )
        if result.text.strip():
            emission, frame_s = aligner.emissions(audio[start:end])
            alignments.append(
                aligner.align(
                    emission,
                    frame_s,
                    result.text,
                    start / sample_rate,
                )
            )
        else:
            alignments.append([])
    transcript = recognition_transcript(
        chunks,
        alignments,
        MODEL,
        ALIGNER_MODEL,
        _MIN_ACOUSTIC_SCORE,
    )
    evidence_words = [
        word
        for chunk, alignment in zip(chunks, alignments, strict=True)
        for word in alignment
        if chunk.ownership_start_s
        <= (word.start_s + word.end_s) / 2
        < chunk.ownership_end_s
    ]
    return align_reference_audio(transcript, audio, aligner, review, evidence_words)


def align_reference_audio(
    transcript: Transcript,
    audio: np.ndarray,
    aligner: VocalAligner,
    review: ReferenceReview | None,
    evidence_words: list[TranscriptWord],
) -> Transcript:
    """Reference-first refinement, also usable with retained real ASR evidence."""
    if review is None:
        return transcript
    review = replace(
        review,
        original_segments=transcript.segments,
        original_words=transcript.words,
        original_untimed=transcript.untimed,
    )
    if not review.lines:
        return replace(transcript, reference=review)
    duration_s = len(audio) / SAMPLE_RATE
    review, phrases = plan_reference(transcript, review, duration_s, evidence_words)
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
    return apply_reference(transcript, review, aligned_lines, acoustic_evidence)


if __name__ == "__main__":
    review = (
        reference_review_from_dict(json.loads(Path(sys.argv[4]).read_text("utf-8")))
        if len(sys.argv) > 4
        else None
    )
    result = transcribe(Path(sys.argv[1]), Path(sys.argv[2]), review)
    Path(sys.argv[3]).write_text(
        json.dumps(asdict(result), ensure_ascii=False, allow_nan=False), "utf-8"
    )
