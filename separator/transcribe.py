"""GPU-only ASR subprocess; never imported by the lightweight web service."""

import json
import math
import sys
from dataclasses import asdict
from pathlib import Path

# Installed only in the isolated Python 3.13 GPU ASR environment, not the web venv.
from faster_whisper import WhisperModel  # ty: ignore[unresolved-import]

from separator.lyrics import Transcript, TranscriptSegment, TranscriptWord

MODEL = "large-v3"


def transcribe(source: Path, model_cache: Path) -> Transcript:
    model = WhisperModel(
        MODEL,
        device="cuda",
        compute_type="float16",
        download_root=str(model_cache),
    )
    segments, info = model.transcribe(
        str(source),
        task="transcribe",
        beam_size=5,
        condition_on_previous_text=False,
        # Speech VAD can discard sustained singing. Decode the full vocal track
        # and let Whisper's no-speech confidence gate skip non-vocal windows.
        vad_filter=False,
        no_speech_threshold=0.6,
        # Do not let confident hallucinated text override no-speech detection.
        # This also disables the low-logprob fallback; compression checks remain.
        log_prob_threshold=None,
        # The default 1s initial-timestamp limit misdates vocals after an intro.
        # Allow the actual onset anywhere inside the model's decoding window.
        max_initial_timestamp=model.feature_extractor.chunk_length,
        word_timestamps=True,
    )
    if not math.isfinite(info.duration) or info.duration <= 0:
        raise ValueError("Lyrics extraction requires audio with a finite duration")
    recognized = []
    previous_end = 0.0
    words = []
    previous_word_end = 0.0
    # faster-whisper performs inference lazily: consume the entire generator.
    for segment in segments:
        text = " ".join(segment.text.split())
        if not text:
            continue
        if not math.isfinite(segment.start) or not math.isfinite(segment.end):
            raise ValueError("ASR returned non-finite timestamps")
        start = max(previous_end, min(info.duration, max(0.0, segment.start)))
        end = min(info.duration, segment.end)
        if end <= start:
            raise ValueError("ASR returned invalid segment timing")
        recognized.append(TranscriptSegment(start, end, text))
        previous_end = end
        for word in segment.words or []:
            token = word.word.strip()
            if not token:
                continue
            if not all(
                math.isfinite(v) for v in (word.start, word.end, word.probability)
            ):
                raise ValueError("ASR returned non-finite word timing or probability")
            word_start = max(previous_word_end, min(info.duration, max(0, word.start)))
            word_end = min(info.duration, word.end)
            # Whisper can assign punctuation/zero-duration tokens; do not invent
            # intervals for them or claim that they identify sung syllables.
            if word_end <= word_start:
                continue
            words.append(TranscriptWord(word_start, word_end, token, word.probability))
            previous_word_end = word_end
    return Transcript(
        segments=recognized, language=info.language if recognized else None, words=words
    )


if __name__ == "__main__":
    result = transcribe(Path(sys.argv[1]), Path(sys.argv[2]))
    Path(sys.argv[3]).write_text(
        json.dumps(asdict(result), ensure_ascii=False), "utf-8"
    )
