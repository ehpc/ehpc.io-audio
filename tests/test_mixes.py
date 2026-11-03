"""Consumer regressions for arbitrary mixes, not UI/copy or routing snapshots."""

import io
import json
import shutil
import sqlite3
from dataclasses import asdict
from pathlib import Path
from typing import TypedDict

import pytest
from audio_samples import decode_audio, ffmpeg_tone, frequency_amplitude
from fastapi.testclient import TestClient
from mutagen.id3 import ID3

from backend import config, db, queue
from backend.metadata import ensure_download_title
from separator import stems
from separator.audio import mix_audio
from separator.options import MixSpec, SeparationOptions, parse_mixes
from separator.stems import Stem, StemResult

_NATIVE = all(shutil.which(tool) for tool in ("ffmpeg", "ffprobe"))
_PAIRS = (
    ("drums", "bass"),
    ("drums", "vocals"),
    ("bass", "vocals"),
    ("drums", "other"),
)


class HistoricalResult(TypedDict):
    label: str
    filename: str
    size_bytes: int
    duration_s: float


@pytest.mark.parametrize(
    "components",
    [*_PAIRS, ("drums", "bass", "vocals"), ("drums", "bass", "vocals", "other")],
)
@pytest.mark.parametrize("dereverb", [False, True])
@pytest.mark.skipif(not _NATIVE, reason="FFmpeg required")
def test_arbitrary_graph_sums_every_selected_component_at_unity_gain(
    components: tuple[str, ...],
    dereverb: bool,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frequencies = {
        "drums": 330,
        "bass": 220,
        "vocals": 550,
        "vocals-dry": 660,
        "other-instruments": 880,
        "instruments": 110,
    }

    def inference(input_path: Path, stem: Stem, out_dir: Path, *args, **kwargs):
        if "vocals" not in components and stem.model == stems.VOCALS_STEM.model:
            raise AssertionError("instrument-only mixes cannot require vocal inference")
        out_dir.mkdir(parents=True)
        outputs = {}
        for output in stem.outputs:
            frequency = frequencies[output.label]
            path = ffmpeg_tone(
                out_dir / f"{output.label}.wav",
                (frequency, frequency + 1100),
                amplitude=0.12,
            )
            outputs[output.label] = (StemResult(path.read_bytes(), 0.1), path)
        return outputs

    monkeypatch.setattr(stems, "run_separator", inference)
    options = SeparationOptions(
        mixes=(MixSpec("mix-example-dry", "Requested mix", components),),
        dereverb=dereverb,
    )
    result = stems.run_separation(
        tmp_path / "source.wav", options, tmp_path, "models", "cache"
    )
    assert list(result) == ["mix-example-dry"]
    audio = decode_audio(result["mix-example-dry"].data)
    assert audio.duration_s == pytest.approx(1, abs=0.04)
    assert audio.sample_rate == 48000 and len(audio.channels) == 2
    assert audio.peak < 0.89
    selected = {frequencies[options.component_label(part)] for part in components}
    for channel in (0, 1):
        for frequency in selected:
            assert frequency_amplitude(
                audio, frequency + channel * 1100, channel=channel
            ) == pytest.approx(0.12, abs=0.015)
        for frequency in set(frequencies.values()) - selected:
            assert (
                frequency_amplitude(audio, frequency + channel * 1100, channel=channel)
                < 0.008
            )


@pytest.mark.skipif(not _NATIVE, reason="FFmpeg required")
@pytest.mark.parametrize("count", [3, 5, 9])
def test_multi_input_overload_is_limited_without_clipping(
    count: int, tmp_path: Path
) -> None:
    inputs = [
        ffmpeg_tone(tmp_path / f"{index}.wav", (1000, 1000), amplitude=0.7)
        for index in range(count)
    ]
    output = tmp_path / "mix.mp3"
    mix_audio(inputs, output)
    audio = decode_audio(output.read_bytes())
    assert audio.duration_s == pytest.approx(1, abs=0.04)
    assert 0.8 < audio.peak < 0.99
    assert frequency_amplitude(audio, 1000) > 0.8


@pytest.mark.parametrize(
    "changes",
    [
        {"id": "../vocals"},
        {"id": "vocals"},
        {"id": "mix-../x"},
        {"id": 1},
        {"name": " "},
        {"name": "x\nheader"},
        {"name": "x" * 121},
        {"name": 2},
        {"components": []},
        {"components": ["bass"]},
        {"components": ["bass", "bass"]},
        {"components": ["bass", "song"]},
        {"components": ["mix-another", "vocals"]},
        {"components": [1, "vocals"]},
        {"components": "bass,vocals"},
        {"extra": True},
    ],
)
def test_invalid_mix_is_rejected_before_queueing(
    client: TestClient, changes: dict
) -> None:
    value = {"id": "mix-ok", "name": "Mix", "components": ["drums", "bass"], **changes}
    response = client.post(
        "/api/jobs",
        data={"url": "https://example.com/song", "mixes": json.dumps([value])},
    )
    assert response.status_code == 422
    assert db.claim_oldest_queued() is None


def test_duplicate_ids_rejected_but_overlapping_components_and_names_allowed() -> None:
    first = MixSpec("mix-a", "Same", ("vocals", "female", "instruments", "drums"))
    second = MixSpec("mix-b", "Same", ("bass", "drums"))
    assert parse_mixes([asdict(first), asdict(second)]) == (first, second)
    with pytest.raises(ValueError, match="unique"):
        parse_mixes([first, first])


@pytest.mark.skipif(not _NATIVE, reason="FFmpeg required")
def test_duplicate_unsafe_names_keep_independent_downloads_metadata_and_retry(
    client: TestClient, other_client: TestClient, tmp_path: Path
) -> None:
    mixes = [
        MixSpec(f"mix-{index}", "../Same\\name?:*", parts)
        for index, parts in enumerate(_PAIRS)
    ]
    selected = [asdict(mix) for mix in mixes]
    original = b"unchanged original"
    response = client.post(
        "/api/jobs",
        files={"file": ("Source.wav", original)},
        data={"mixes": json.dumps(selected)},
    )
    job_id = response.json()["id"]
    job = db.get_job(job_id)
    assert job is not None
    inputs = [
        ffmpeg_tone(tmp_path / f"part-{i}.wav", (frequency, frequency), amplitude=0.1)
        for i, frequency in enumerate((220, 550))
    ]
    output = tmp_path / "mix.mp3"
    mix_audio(inputs, output)
    manifest = queue._persist_results(
        job, {mix.id: StemResult(output.read_bytes(), 0.1) for mix in mixes}
    )
    db.mark_done(job_id, manifest)
    dto = client.get(f"/api/jobs/{job_id}").json()
    assert len({entry["filename"] for entry in dto["manifest"]}) == 4
    assert len({entry["download_name"] for entry in dto["manifest"]}) == 4
    for entry in dto["manifest"]:
        assert entry["display_name"] == mixes[0].name
        assert not any(char in entry["download_name"] for char in '/\\:*?"<>|')
        download = client.get(f"/api/jobs/{job_id}/results/{entry['label']}")
        assert download.status_code == 200
        assert ID3(io.BytesIO(download.content))["TIT2"].text == [
            entry["download_name"].removesuffix(".mp3")
        ]
        assert (
            other_client.get(f"/api/jobs/{job_id}/results/{entry['label']}").status_code
            == 404
        )
    assert client.get(f"/api/jobs/{job_id}/original").content == original
    assert other_client.post(f"/api/jobs/{job_id}/retry").status_code == 404
    retried = client.post(f"/api/jobs/{job_id}/retry").json()["id"]
    assert client.get(f"/api/jobs/{retried}").json()["options"] == dto["options"]
    db.reap_running_to_queued()
    db.init_db()
    assert client.get(f"/api/jobs/{job_id}").json()["manifest"] == dto["manifest"]


def test_legacy_migration_is_persisted_once_and_keeps_audio_files(
    client: TestClient,
) -> None:
    job_id = client.post("/api/jobs", data={"url": "https://example.com/song"}).json()[
        "id"
    ]
    old = {
        "extract_vocals": False,
        "extract_instruments": False,
        **{
            f"mix_{part}_instruments": True
            for part in ("female", "male", "backing", "lead")
        },
    }
    manifest: list[HistoricalResult] = [
        {
            "label": f"{part}-instruments",
            "filename": f"{part}-instruments.mp3",
            "size_bytes": 4,
            "duration_s": 1,
        }
        for part in ("female", "male", "backing", "lead")
    ]
    root = config.RESULTS_DIR / str(job_id)
    root.mkdir(parents=True)
    for entry in manifest:
        (root / entry["filename"]).write_bytes(b"data")
        ensure_download_title(
            root / entry["filename"], f"{job_id} - {entry['label']}.mp3"
        )
        entry["size_bytes"] = (root / entry["filename"]).stat().st_size
    original_files = {path.name: path.read_bytes() for path in root.iterdir()}
    with sqlite3.connect(config.DB_PATH) as connection:
        connection.execute(
            "UPDATE jobs SET options_json=?, result_manifest_json=?, status='done' "
            "WHERE id=?",
            (json.dumps(old), json.dumps(manifest), job_id),
        )
    db.init_db()
    once = client.get(f"/api/jobs/{job_id}").json()
    db.init_db()
    assert client.get(f"/api/jobs/{job_id}").json() == once
    assert [mix["id"] for mix in once["options"]["mixes"]] == [
        f"mix-legacy-{part}" for part in ("female", "male", "backing", "lead")
    ]
    assert [entry["filename"] for entry in once["manifest"]] == [
        entry["filename"] for entry in manifest
    ]
    assert [entry["label"] for entry in once["manifest"]] == [
        entry["label"] for entry in manifest
    ]
    for entry in manifest:
        response = client.get(f"/api/jobs/{job_id}/results/{entry['label']}")
        assert response.status_code == 200
        assert response.content == original_files[entry["filename"]]
    assert {path.name: path.read_bytes() for path in root.iterdir()} == original_files
    with sqlite3.connect(config.DB_PATH) as connection:
        stored = json.loads(
            connection.execute(
                "SELECT options_json FROM jobs WHERE id=?", (job_id,)
            ).fetchone()[0]
        )
    assert not any(key.startswith("mix_") for key in stored)
    assert len(stored["mixes"]) == 4
    retry_id = client.post(f"/api/jobs/{job_id}/retry").json()["id"]
    assert client.get(f"/api/jobs/{retry_id}").json()["options"] == once["options"]


@pytest.mark.parametrize("field", ["unknown_option", "mix_female_instruments"])
def test_unknown_submission_fields_never_queue_download_only(
    client: TestClient, field: str
) -> None:
    response = client.post(
        "/api/jobs", data={"url": "https://example.com/song", field: "true"}
    )
    assert response.status_code == 422
    assert db.claim_oldest_queued() is None


def test_interrupted_mix_job_requeues_same_identities(client: TestClient) -> None:
    mix = {"id": "mix-1", "name": "Rhythm", "components": ["drums", "bass"]}
    job_id = client.post(
        "/api/jobs",
        data={"url": "https://example.com/song", "mixes": json.dumps([mix])},
    ).json()["id"]
    claimed = db.claim_oldest_queued()
    assert claimed is not None and claimed.id == job_id
    db.set_modal_call_id(job_id, "cancelled-test-call")
    db.reap_running_to_queued()
    resumed = db.claim_oldest_queued()
    assert resumed is not None and resumed.id == job_id
    assert resumed.options == claimed.options
    assert resumed.options.output_labels == ["mix-1"]
