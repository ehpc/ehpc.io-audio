from collections import Counter
from dataclasses import replace
from itertools import product
from pathlib import Path
from typing import NamedTuple

import pytest

from separator import stems
from separator.options import MixSpec, SeparationOptions
from separator.stems import Stem, StemResult


class SeparatorCall(NamedTuple):
    source: Path
    stem: Stem


class MixCall(NamedTuple):
    inputs: list[Path]
    output: Path


@pytest.fixture
def graph(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    calls: list[SeparatorCall] = []
    mixes: list[MixCall] = []

    def separate(
        input_path: Path,
        stem: Stem,
        out_dir: Path,
        model_cache: str,
        stem_cache: str,
    ) -> dict[str, tuple[StemResult, Path]]:
        calls.append(SeparatorCall(input_path, stem))
        out_dir.mkdir(parents=True, exist_ok=True)
        for output in stem.outputs:
            (out_dir / f"{output.label}.mp3").write_bytes(output.label.encode())
        return {
            output.label: (
                StemResult(data=b"audio", duration_s=1.0),
                out_dir / f"{output.label}.mp3",
            )
            for output in stem.outputs
        }

    def mix(inputs: list[Path], output: Path) -> None:
        mixes.append(MixCall(inputs, output))
        output.write_bytes(b"rendered mix")

    monkeypatch.setattr(stems, "run_separator", separate)
    monkeypatch.setattr(stems, "mix_audio", mix)

    def run(options: SeparationOptions) -> dict[str, StemResult]:
        return stems.run_separation(
            tmp_path / "original.mp3",
            options,
            tmp_path,
            str(tmp_path / "models"),
            str(tmp_path / "cache"),
        )

    return run, calls, mixes


@pytest.mark.parametrize(
    "options",
    [
        SeparationOptions(),
        SeparationOptions(pitch_semitones=7, tempo_percent=120),
    ],
)
def test_download_only_does_not_run_any_models(
    graph, options: SeparationOptions
) -> None:
    run, calls, mixes = graph
    assert run(options) == {}
    assert calls == []
    assert mixes == []


@pytest.mark.parametrize(
    ("flags", "expected", "models"),
    [
        ({"extract_vocals": True}, ["vocals"], [stems.VOCALS_STEM.model]),
        (
            {"extract_instruments": True},
            ["instruments"],
            [stems.INSTRUMENTS_STEM.model],
        ),
        (
            {"decrowd_vocals": True},
            ["vocals-decrowded"],
            [stems.VOCALS_STEM.model, stems.DECROWD_VOCALS_STEMS[0].model],
        ),
        (
            {"decrowd": True},
            ["instruments-decrowded"],
            [stems.INSTRUMENTS_STEM.model, stems.DECROWD_STEMS[0].model],
        ),
        (
            {"genders": True},
            ["vocals-male", "vocals-female"],
            [stems.VOCALS_STEM.model, stems.GENDER_STEMS[0].model],
        ),
        (
            {"lead_backing": True},
            ["lead", "backing"],
            [stems.VOCALS_STEM.model, stems.LEAD_BACKING_STEMS[0].model],
        ),
        (
            {"drums": True},
            ["drums", "bass", "other-instruments"],
            [stems.INSTRUMENTS_STEM.model, stems.DRUM_STEMS.model],
        ),
        (
            {"dereverb": True},
            ["vocals-dry"],
            [stems.VOCALS_STEM.model, stems.DEREVERB_MODEL],
        ),
    ],
)
def test_independent_outputs_hide_prerequisites_and_run_minimum_models(
    graph, flags: dict[str, bool], expected: list[str], models: list[str]
) -> None:
    run, calls, mixes = graph
    result = run(replace(SeparationOptions(), **flags))
    assert list(result) == expected
    assert [call.stem.model for call in calls] == models
    assert mixes == []


@pytest.mark.parametrize(
    ("flags", "expected"),
    [
        ({"extract_vocals": True}, ["vocals", "vocals-dry"]),
        (
            {"decrowd_vocals": True},
            ["vocals-decrowded", "vocals-decrowded-dry"],
        ),
        (
            {"genders": True},
            ["vocals-male", "vocals-male-dry", "vocals-female", "vocals-female-dry"],
        ),
        ({"lead_backing": True}, ["lead", "lead-dry", "backing", "backing-dry"]),
        ({"extract_instruments": True}, ["instruments"]),
        ({"decrowd": True}, ["instruments-decrowded"]),
        ({"drums": True}, ["drums", "bass", "other-instruments"]),
    ],
)
def test_dereverb_only_pairs_explicit_vocal_outputs(
    graph, flags: dict[str, bool], expected: list[str]
) -> None:
    run, calls, _ = graph
    assert list(run(replace(SeparationOptions(dereverb=True), **flags))) == expected
    dry_calls = [call for call in calls if call.stem.model == stems.DEREVERB_MODEL]
    assert [call.source.name for call in dry_calls] == [
        f"{label.removesuffix('-dry')}.mp3"
        for label in expected
        if label.endswith("-dry")
    ]
    if not any(label.endswith("-dry") for label in expected):
        assert all(call.stem.model != stems.VOCALS_STEM.model for call in calls)


def test_explicit_base_outputs_are_independent(graph) -> None:
    run, calls, mixes = graph
    assert list(
        run(
            SeparationOptions(
                extract_vocals=True,
                extract_instruments=True,
            )
        )
    ) == ["vocals", "instruments"]
    assert [call.stem.model for call in calls] == [
        stems.VOCALS_STEM.model,
        stems.INSTRUMENTS_STEM.model,
    ]
    assert mixes == []


def test_every_boolean_combination_has_exact_outputs_and_valid_dependencies(graph):
    """Exhaust independent output flags without invoking costly inference."""
    run, calls, mixes = graph
    flags = (
        "extract_vocals",
        "extract_instruments",
        "decrowd",
        "decrowd_vocals",
        "dereverb",
        "genders",
        "lead_backing",
        "drums",
    )
    public_outputs = (
        ("vocals", "extract_vocals"),
        ("vocals-decrowded", "decrowd_vocals"),
        ("vocals-male", "genders"),
        ("vocals-female", "genders"),
        ("lead", "lead_backing"),
        ("backing", "lead_backing"),
        ("instruments", "extract_instruments"),
        ("instruments-decrowded", "decrowd"),
        ("drums", "drums"),
        ("bass", "drums"),
        ("other-instruments", "drums"),
    )
    vocal_labels = {
        "vocals",
        "vocals-decrowded",
        "vocals-male",
        "vocals-female",
        "lead",
        "backing",
    }
    for values in product((False, True), repeat=len(flags)):
        selected = dict(zip(flags, values, strict=True))
        options = replace(SeparationOptions(), **selected)
        expected = []
        for label, flag in public_outputs:
            if selected[flag]:
                expected.append(label)
                if options.dereverb and label in vocal_labels:
                    expected.append(f"{label}-dry")
        if options.dereverb and not expected:
            expected = ["vocals-dry"]
        calls.clear()
        mixes.clear()
        result = run(options)
        assert list(result) == expected, selected
        assert options.output_labels == expected, selected
        assert options.result_labels == expected, selected
        assert replace(
            options, pitch_semitones=-2.5, tempo_percent=125
        ).result_labels == ["song", *expected], selected
        assert replace(options, tempo_percent=125).result_labels == (
            expected or ["song"]
        ), selected
        assert len({(call.source, call.stem.model) for call in calls}) == len(calls)
        available = {"original.mp3"}
        for call in calls:
            assert call.source.name in available, (selected, call)
            available.update(f"{output.label}.mp3" for output in call.stem.outputs)
            if call.stem.model in {
                stems.GENDER_STEMS[0].model,
                stems.LEAD_BACKING_STEMS[0].model,
            }:
                expected_vocal = (
                    "vocals-decrowded.mp3" if options.decrowd_vocals else "vocals.mp3"
                )
                assert call.source.name == expected_vocal


def test_lyrics_prerequisite_does_not_add_raw_vocal_dereverb_passes(
    graph,
) -> None:
    run, calls, mixes = graph
    result = run(
        SeparationOptions(
            extract_lyrics=True,
            mixes=(MixSpec("mix-lead", "Lead + Instruments", ("lead", "instruments")),),
            dereverb=True,
        )
    )
    # Raw vocals are internal ASR input, not another selected wet/dry pair.
    assert list(result) == ["mix-lead", "vocals"]
    assert Counter(call.stem.model for call in calls) == Counter(
        {
            stems.VOCALS_STEM.model: 1,
            stems.LEAD_BACKING_STEMS[0].model: 1,
            stems.DEREVERB_MODEL: 1,
            stems.INSTRUMENTS_STEM.model: 1,
        }
    )
    dry_calls = [call for call in calls if call.stem.model == stems.DEREVERB_MODEL]
    assert dry_calls[0].source.name == "lead.mp3"
    assert len(mixes) == 1
    assert mixes[0].inputs[0].name == "lead-dry.mp3"


def test_lyrics_only_shares_one_raw_vocal_pass_and_no_audio_outputs(graph) -> None:
    run, calls, mixes = graph
    options = SeparationOptions(extract_lyrics=True)
    assert list(run(options)) == ["vocals"]
    assert options.output_labels == []
    assert options.result_labels == []
    assert [call.stem.model for call in calls] == [stems.VOCALS_STEM.model]
    assert mixes == []
