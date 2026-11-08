"""GPU-only multilingual CTC alignment with observed frame-emission scores.

MMS_FA weights are CC-BY-NC-4.0: noncommercial use only without separate rights.
The scores are acoustic alignment evidence, not calibrated lyric correctness.
"""

import re
from pathlib import Path

import numpy as np
import torch  # ty: ignore[unresolved-import]
import torchaudio  # ty: ignore[unresolved-import]
import uroman  # ty: ignore[unresolved-import]

from separator.cache_versions import ASR_SAMPLE_RATE as SAMPLE_RATE
from separator.lyrics import TranscriptWord
from separator.lyrics_reference import tokens


class VocalAligner:
    def __init__(self, model_cache: Path):
        torch.hub.set_dir(str(model_cache / "torch"))
        bundle = torchaudio.pipelines.MMS_FA
        self.model = bundle.get_model().to("cuda").eval()
        self.tokenizer = bundle.get_tokenizer()
        self.aligner = bundle.get_aligner()
        self.romanizer = uroman.Uroman()
        self.star_index = bundle.get_dict()["*"]

    def _romanized(self, text: str) -> list[str]:
        return [
            re.sub("[^a-z']", "", self.romanizer.romanize_string(word).lower())
            for word in tokens(text)
        ]

    def search(
        self,
        emission,
        frame_s: float,
        text: str,
        offset_s: float,
        start_s: float,
        end_s: float,
    ) -> list[TranscriptWord]:
        """Constrain the alignment lattice, not the 20-30s acoustic input.

        Original posterior scores inside the search region remain untouched.
        Actual phone-frame positions, NOT provider onsets, become word times.
        """
        first = max(0, round((start_s - offset_s) / frame_s))
        last = min(emission.shape[0], round((end_s - offset_s) / frame_s))
        if last <= first:
            return []
        constrained = emission.clone()
        constrained[:first, 1 : self.star_index] = -10000
        constrained[last:, 1 : self.star_index] = -10000
        return self.align(constrained, frame_s, text, offset_s)

    @torch.inference_mode()
    def log_score(self, emission, text: str) -> float:
        """CTC log likelihood per INPUT FRAME, on identical acoustic context.

        No wildcard tokens participate in scoring. Comparing whole phrases
        differing in one line controls context and does not average by target
        word/character count (which would favor different-length spellings).
        """
        romanized = self._romanized(text)
        if any(not word for word in romanized):
            return float("-inf")
        target = [token for word in self.tokenizer(romanized) for token in word]
        if not target or len(target) > emission.shape[0]:
            return float("-inf")
        loss = torch.nn.functional.ctc_loss(
            emission[:, None, : self.star_index],
            torch.tensor(target, device=emission.device, dtype=torch.long),
            torch.tensor([emission.shape[0]], device=emission.device),
            torch.tensor([len(target)], device=emission.device),
            blank=0,
            reduction="sum",
        )
        return -float(loss) / emission.shape[0]

    @torch.inference_mode()
    def emissions(self, audio: np.ndarray):
        waveform = torch.from_numpy(audio).unsqueeze(0).to("cuda")
        emission, _ = self.model(waveform)
        return emission[0], len(audio) / SAMPLE_RATE / emission.shape[1]

    def align(
        self, emission, frame_s: float, text: str, offset_s: float
    ) -> list[TranscriptWord]:
        originals = tokens(text)
        romanized = self._romanized(text)
        if not romanized or any(not word for word in romanized):
            return []
        # Wildcard boundaries absorb music, breaths and neighboring phrases.
        # Without them CTC forces the last word to consume trailing silence.
        spans = self.aligner(emission, self.tokenizer(["*", *romanized, "*"]))[1:-1]
        words = []
        for text, units in zip(originals, spans, strict=True):
            length = sum(unit.end - unit.start for unit in units)
            if not units or length <= 0:
                return []
            score = sum(unit.score * (unit.end - unit.start) for unit in units) / length
            words.append(
                TranscriptWord(
                    offset_s + units[0].start * frame_s,
                    offset_s + units[-1].end * frame_s,
                    text,
                    alignment_score=score,
                )
            )
        return words
