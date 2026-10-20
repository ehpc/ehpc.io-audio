from collections import Counter
from pathlib import Path
from typing import NamedTuple

import pytest

from separator import stems
from separator.options import SeparationOptions
from separator.stems import Stem, StemResult


class SeparatorCall(NamedTuple):
    source: Path
    stem: Stem
    use_cache: bool


class MixCall(NamedTuple):
    vocals: Path
    instruments: Path
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
        use_cache: bool = True,
    ) -> dict[str, tuple[StemResult, Path]]:
        calls.append(SeparatorCall(input_path, stem, use_cache))
        return {
            output.label: (
                StemResult(data=b"audio", duration_s=1.0),
                out_dir / f"{output.label}.mp3",
            )
            for output in stem.outputs
        }

    def mix(vocals: Path, instruments: Path, output: Path) -> None:
        mixes.append(MixCall(vocals, instruments, output))
        output.write_bytes(b"rendered mix")

    monkeypatch.setattr(stems, "run_separator", separate)
    monkeypatch.setattr(stems, "mix_audio", mix)

    def run(options: SeparationOptions) -> dict[str, StemResult]:
        return stems.run_separation(
            tmp_path / "original.mp3", options, tmp_path, "models", "cache"
        )

    return run, calls, mixes


@pytest.mark.parametrize(
    "options",
    [
        SeparationOptions(),
        SeparationOptions(no_cache=True),
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
    result = run(SeparationOptions(**flags))
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
    assert list(run(SeparationOptions(dereverb=True, **flags))) == expected
    dry_calls = [call for call in calls if call.stem.model == stems.DEREVERB_MODEL]
    assert [call.source.name for call in dry_calls] == [
        f"{label.removesuffix('-dry')}.mp3"
        for label in expected
        if label.endswith("-dry")
    ]
    if not any(label.endswith("-dry") for label in expected):
        assert all(call.stem.model != stems.VOCALS_STEM.model for call in calls)


@pytest.mark.parametrize(
    ("flag", "label", "vocal", "split_model"),
    [
        (
            "mix_female_instruments",
            "female-instruments",
            "vocals-female",
            stems.GENDER_STEMS[0].model,
        ),
        (
            "mix_male_instruments",
            "male-instruments",
            "vocals-male",
            stems.GENDER_STEMS[0].model,
        ),
        (
            "mix_backing_instruments",
            "backing-instruments",
            "backing",
            stems.LEAD_BACKING_STEMS[0].model,
        ),
    ],
)
@pytest.mark.parametrize("dereverb", [False, True])
def test_mix_only_never_exposes_prerequisites(
    graph, flag: str, label: str, vocal: str, split_model: str, dereverb: bool
) -> None:
    run, calls, mixes = graph
    result = run(SeparationOptions(**{flag: True}, dereverb=dereverb))
    assert list(result) == [label]
    expected_models = [stems.VOCALS_STEM.model, split_model]
    if dereverb:
        expected_models.append(stems.DEREVERB_MODEL)
    expected_models.append(stems.INSTRUMENTS_STEM.model)
    assert [call.stem.model for call in calls] == expected_models
    assert len(mixes) == 1
    assert mixes[0].vocals.name == f"{vocal}{'-dry' if dereverb else ''}.mp3"
    assert mixes[0].instruments.name == "instruments.mp3"
    assert mixes[0].output.name == f"{label}.mp3"
    if dereverb:
        assert (
            next(
                call.source.name
                for call in calls
                if call.stem.model == stems.DEREVERB_MODEL
            )
            == f"{vocal}.mp3"
        )


@pytest.mark.parametrize("genders", [False, True])
@pytest.mark.parametrize("dereverb", [False, True])
def test_female_and_male_mixes_share_gender_and_dry_passes(
    graph, genders: bool, dereverb: bool
) -> None:
    run, calls, mixes = graph
    result = run(
        SeparationOptions(
            genders=genders,
            dereverb=dereverb,
            mix_female_instruments=True,
            mix_male_instruments=True,
        )
    )
    expected = []
    if genders:
        for label in ("vocals-male", "vocals-female"):
            expected.append(label)
            if dereverb:
                expected.append(f"{label}-dry")
    assert list(result) == [*expected, "female-instruments", "male-instruments"]
    models = Counter(call.stem.model for call in calls)
    assert models == Counter(
        {
            stems.VOCALS_STEM.model: 1,
            stems.GENDER_STEMS[0].model: 1,
            stems.INSTRUMENTS_STEM.model: 1,
            **({stems.DEREVERB_MODEL: 2} if dereverb else {}),
        }
    )
    assert [mix.vocals.name for mix in mixes] == [
        f"vocals-female{'-dry' if dereverb else ''}.mp3",
        f"vocals-male{'-dry' if dereverb else ''}.mp3",
    ]


@pytest.mark.parametrize("decrowd_vocals", [False, True])
@pytest.mark.parametrize("decrowd", [False, True])
def test_all_mixes_use_cleaned_split_inputs_and_instruments_when_selected(
    graph, decrowd_vocals: bool, decrowd: bool
) -> None:
    run, calls, mixes = graph
    result = run(
        SeparationOptions(
            decrowd_vocals=decrowd_vocals,
            decrowd=decrowd,
            dereverb=True,
            mix_female_instruments=True,
            mix_male_instruments=True,
            mix_backing_instruments=True,
        )
    )
    expected = []
    if decrowd_vocals:
        expected.extend(("vocals-decrowded", "vocals-decrowded-dry"))
    if decrowd:
        expected.append("instruments-decrowded")
    assert list(result) == [
        *expected,
        "female-instruments",
        "male-instruments",
        "backing-instruments",
    ]
    for model in (stems.GENDER_STEMS[0].model, stems.LEAD_BACKING_STEMS[0].model):
        split_calls = [call for call in calls if call.stem.model == model]
        assert len(split_calls) == 1
        assert split_calls[0].source.name == (
            "vocals-decrowded.mp3" if decrowd_vocals else "vocals.mp3"
        )
    assert [mix.vocals.name for mix in mixes] == [
        "vocals-female-dry.mp3",
        "vocals-male-dry.mp3",
        "backing-dry.mp3",
    ]
    assert {mix.instruments.name for mix in mixes} == {
        "instruments-decrowded.mp3" if decrowd else "instruments.mp3"
    }
    dry_sources = [
        call.source.name for call in calls if call.stem.model == stems.DEREVERB_MODEL
    ]
    assert Counter(dry_sources) == Counter(
        [
            *(["vocals-decrowded.mp3"] if decrowd_vocals else []),
            "vocals-female.mp3",
            "vocals-male.mp3",
            "backing.mp3",
        ]
    )
    assert Counter(call.stem.model for call in calls) == Counter(
        {
            stems.VOCALS_STEM.model: 1,
            stems.GENDER_STEMS[0].model: 1,
            stems.LEAD_BACKING_STEMS[0].model: 1,
            stems.INSTRUMENTS_STEM.model: 1,
            stems.DEREVERB_MODEL: 3 + int(decrowd_vocals),
            **(
                {stems.DECROWD_STEMS[0].model: int(decrowd) + int(decrowd_vocals)}
                if decrowd or decrowd_vocals
                else {}
            ),
        }
    )


def test_all_options_keep_explicit_wet_dry_pairs_adjacent(graph) -> None:
    run, calls, mixes = graph
    result = run(
        SeparationOptions(
            extract_vocals=True,
            extract_instruments=True,
            decrowd=True,
            decrowd_vocals=True,
            dereverb=True,
            genders=True,
            lead_backing=True,
            drums=True,
            mix_female_instruments=True,
            mix_male_instruments=True,
            mix_backing_instruments=True,
            no_cache=True,
        )
    )
    assert list(result) == [
        "vocals",
        "vocals-dry",
        "vocals-decrowded",
        "vocals-decrowded-dry",
        "vocals-male",
        "vocals-male-dry",
        "vocals-female",
        "vocals-female-dry",
        "lead",
        "lead-dry",
        "backing",
        "backing-dry",
        "instruments",
        "instruments-decrowded",
        "drums",
        "bass",
        "other-instruments",
        "female-instruments",
        "male-instruments",
        "backing-instruments",
    ]
    assert len(calls) == 13
    assert all(not call.use_cache for call in calls)
    assert len(mixes) == 3


def test_explicit_base_outputs_are_independent_and_use_cache_by_default(graph) -> None:
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
    assert all(call.use_cache for call in calls)
    assert mixes == []
