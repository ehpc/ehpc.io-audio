from pathlib import Path

import pytest

from separator import stems
from separator.options import SeparationOptions
from separator.stems import Stem, StemResult


def _fake_run_separator(
    input_path: Path,
    stem: Stem,
    out_dir: Path,
    model_cache: str,
    stem_cache: str,
    use_cache: bool = True,
) -> dict[str, tuple[StemResult, Path]]:
    return {
        output.label: (
            StemResult(data=b"x", duration_s=0.0),
            Path(f"{output.label}.mp3"),
        )
        for output in stem.outputs
    }


def _labels(opts: SeparationOptions, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    monkeypatch.setattr(stems, "run_separator", _fake_run_separator)
    result = stems.run_separation(Path("in.mp3"), opts, Path("/tmp"), "mc", "sc")
    return list(result.keys())


def test_base_stems(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _labels(SeparationOptions(), monkeypatch) == ["vocals", "instruments"]


def test_dereverb_pairs_with_vocals(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _labels(SeparationOptions(dereverb=True), monkeypatch) == [
        "vocals",
        "vocals-dry",
        "instruments",
    ]


def test_no_dry_stems_without_dereverb(monkeypatch: pytest.MonkeyPatch) -> None:
    labels = _labels(SeparationOptions(genders=True, lead_backing=True), monkeypatch)
    assert not any(label.endswith("-dry") for label in labels)


def test_decrowd_vocals_pairs_with_dry(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _labels(
        SeparationOptions(decrowd_vocals=True, dereverb=True), monkeypatch
    ) == [
        "vocals",
        "vocals-dry",
        "vocals-decrowded",
        "vocals-decrowded-dry",
        "instruments",
    ]


def test_all_options_keep_wet_dry_adjacent(monkeypatch: pytest.MonkeyPatch) -> None:
    opts = SeparationOptions(
        decrowd=True,
        decrowd_vocals=True,
        dereverb=True,
        genders=True,
        lead_backing=True,
        drums=True,
    )
    # A split model emits both of its stems in one pass, so the wet pair comes
    # out together, then the dry pair — dry stays grouped with its wet source.
    assert _labels(opts, monkeypatch) == [
        "vocals",
        "vocals-dry",
        "vocals-decrowded",
        "vocals-decrowded-dry",
        "vocals-male",
        "vocals-female",
        "vocals-male-dry",
        "vocals-female-dry",
        "lead",
        "backing",
        "lead-dry",
        "backing-dry",
        "instruments",
        "instruments-decrowded",
        "drums",
        "bass",
        "other-instruments",
    ]
