import asyncio
import json
import math
import pickle
import shutil
import zipfile
from dataclasses import asdict
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from audio_samples import mp3_measurements, tone_wav
from fastapi.testclient import TestClient

from backend import db, modal_client, queue
from separator import cache_versions, stems
from separator.artifact_cache import cache_key, digest
from separator.lyrics import TranscriptWord
from separator.options import MixSpec, SeparationOptions
from separator.pitch import (
    PitchAnalysis,
    PitchNote,
    PitchTrack,
    pitch_from_json,
    pitch_to_json,
    segment_frames,
    transform_analysis,
)
from separator.processing import ProcessingResult

_NATIVE_TRANSFORM = all(
    shutil.which(tool) is not None for tool in ("ffmpeg", "rubberband")
)


def test_voicing_gates_rests_and_octave_glitches_do_not_invent_notes() -> None:
    # The 30 ms octave glitch and vibrato are not new notes; a sustained real
    # octave change is. Even a confident CREPE output on silence must disappear.
    frequencies = [440 * 2 ** (0.3 * math.sin(i) / 12) for i in range(60)]
    frequencies[20:23] = [880] * 3
    frequencies += [440] * 20 + [880] * 40 + [660] * 20 + [440] * 20
    confidence = [0.9] * len(frequencies)
    confidence[120:140] = [0.20] * 20
    levels = [0.1] * len(frequencies)
    levels[60:80] = [0.0009] * 20
    notes = segment_frames(frequencies, confidence, levels, 1.6)
    assert [note.note for note in notes] == ["A4", "A5", "A4"]
    assert notes[0].end_s == pytest.approx(0.595)
    assert notes[1].start_s == pytest.approx(0.795)
    assert notes[1].end_s == pytest.approx(1.195)
    assert notes[2].start_s == pytest.approx(1.395)
    assert all(note.confidence == 0.9 for note in notes)


def test_short_regions_are_omitted_but_repeated_notes_across_rests_stay_distinct() -> (
    None
):
    notes = segment_frames(
        [440] * 20 + [0] * 10 + [440] * 20 + [660] * 4,
        [0.9] * 54,
        [0.1] * 54,
        0.54,
    )
    assert [note.note for note in notes] == ["A4", "A4"]
    assert notes[0].end_s < notes[1].start_s
    assert segment_frames([440] * 20, [1] * 20, [0] * 20, 0.2) == []
    assert segment_frames([440] * 20, [0.209] * 20, [1] * 20, 0.2) == []


def test_fractional_transposition_tempo_and_melisma_preserve_measured_information() -> (
    None
):
    source = PitchAnalysis(
        8,
        8,
        [
            PitchTrack(
                "lead",
                [
                    PitchNote(2, 3, 60.1, 440 * 2 ** ((60.1 - 69) / 12), 0.8),
                    PitchNote(3, 4, 62.1, 440 * 2 ** ((62.1 - 69) / 12), 0.7),
                    PitchNote(6, 7, 64, 329.6276, 0.9),
                ],
            )
        ],
    )
    words = [
        TranscriptWord(2, 4.1, "world", 0.95),
        TranscriptWord(5, 5.5, "no-overlap", 0.8),
    ]
    result = transform_analysis(source, 1.25, 125, words)
    assert result.timestamp_reference == result.pitch_reference == "output"
    assert result.source_duration_s == 8
    assert result.duration_s == 6.4
    first, second, third = result.tracks[0].notes
    assert first.start_s == 1.6
    assert first.end_s == 2.4
    assert first.midi == pytest.approx(61.35)
    assert first.note == "C#4"
    assert first.cents == 35
    assert first.frequency_hz / source.tracks[0].notes[0].frequency_hz == pytest.approx(
        2 ** (1.25 / 12)
    )
    assert first.word_indices == second.word_indices == [0]
    assert third.word_indices == []
    assert result.words[0].end_s == pytest.approx(3.28)
    assert words[0].end_s == 4.1
    assert source.tracks[0].notes[0].midi == 60.1
    assert pitch_from_json(pitch_to_json(result)) == result


@pytest.mark.parametrize(
    "options,expected",
    [
        (SeparationOptions(), []),
        (SeparationOptions(detect_pitch=True), ["vocals"]),
        (SeparationOptions(detect_pitch=True, extract_instruments=True), ["vocals"]),
        (
            SeparationOptions(
                detect_pitch=True,
                mixes=(
                    MixSpec(
                        "mix-female", "Female + Instruments", ("female", "instruments")
                    ),
                ),
            ),
            ["vocals"],
        ),
        (
            SeparationOptions(detect_pitch=True, lead_backing=True, dereverb=True),
            ["lead", "lead-dry", "backing", "backing-dry"],
        ),
        (
            SeparationOptions(detect_pitch=True, genders=True, extract_vocals=True),
            ["vocals", "vocals-male", "vocals-female"],
        ),
    ],
)
def test_pitch_targets_every_requested_vocal_stem_not_instrumental_mixes(
    options: SeparationOptions, expected: list[str]
) -> None:
    assert options.pitch_labels == expected
    if options.detect_pitch and not options.output_labels:
        assert options.result_labels == []


def test_pitch_lifecycle_download_history_retry_and_session_isolation(
    client: TestClient, other_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    analysis = PitchAnalysis(
        5, 5, [PitchTrack("vocals", [PitchNote(1, 2, 69, 440, 0.9)])]
    )
    encoded = pitch_to_json(analysis)
    response = client.post(
        "/api/jobs",
        files={"file": ("歌声.wav", b"source", "audio/wav")},
        data={"detect_pitch": "true"},
    )
    job_id = response.json()["id"]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        modal_client, "spawn_with_lyrics", lambda *args: MagicMock(object_id="fc-pitch")
    )
    monkeypatch.setattr(
        modal_client, "poll", lambda *args: ProcessingResult({}, pitch_json=encoded)
    )
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["status"] == "done", payload["error_message"]
    assert payload["manifest"] == []
    assert payload["transcript"] is None
    assert payload["pitch"] == json.loads(encoded)
    download = client.get(f"/api/jobs/{job_id}/pitch")
    assert download.json() == payload["pitch"]
    assert "application/json" in download.headers["content-type"]
    assert "pitch.json" in download.headers["content-disposition"]
    db.init_db()
    assert client.get("/api/jobs").json()[0]["pitch"] == payload["pitch"]
    assert client.get("/api/jobs/current").json()["pitch"] == payload["pitch"]
    assert (
        json.loads(
            client.get(f"/api/jobs/{job_id}/events").text.removeprefix("data: ")
        )["pitch"]
        == payload["pitch"]
    )
    assert other_client.get(f"/api/jobs/{job_id}/pitch").status_code == 404
    assert other_client.get(f"/api/jobs/{job_id}").status_code == 404
    assert client.get(f"/api/jobs/{job_id}/results/vocals").status_code == 404
    assert client.post(f"/api/jobs/{job_id}/retry").status_code == 200
    assert client.get("/api/jobs/current").json()["options"]["detect_pitch"] is True


@pytest.mark.skipif(not _NATIVE_TRANSFORM, reason="FFmpeg and Rubber Band required")
def test_pitch_only_job_serves_its_private_vocal_reference_to_its_owner(
    client: TestClient, other_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    analysis = PitchAnalysis(
        2, 2, [PitchTrack("vocals", [PitchNote(0.2, 0.8, 69, 440, 0.9)])]
    )
    encoded = pitch_to_json(analysis)
    source_bytes = tone_wav((440,), duration_s=2)
    private_audio = source_bytes
    response = client.post(
        "/api/jobs",
        files={"file": ("song.wav", source_bytes, "audio/wav")},
        data={
            "detect_pitch": "true",
            "pitch_semitones": "12",
            "tempo_percent": "125",
        },
    )
    job_id = response.json()["id"]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        modal_client, "spawn_with_lyrics", lambda *args: MagicMock(object_id="fc-pitch")
    )
    monkeypatch.setattr(
        modal_client,
        "poll",
        lambda *args: ProcessingResult(
            {}, pitch_json=encoded, pitch_vocals=private_audio
        ),
    )
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))

    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["status"] == "done"
    assert [entry["label"] for entry in payload["manifest"]] == ["song"]
    assert payload["has_pitch_vocals"] is True
    assert client.get(f"/api/jobs/{job_id}/results/vocals").status_code == 404
    reference = client.get(f"/api/jobs/{job_id}/pitch-reference/vocals")
    assert reference.status_code == 200
    duration, frequency = mp3_measurements(reference.content)
    assert duration == pytest.approx(2 / 1.25, abs=0.12)
    assert frequency == pytest.approx(880, rel=0.02)
    assert reference.headers["content-type"].startswith("audio/")
    assert (
        other_client.get(f"/api/jobs/{job_id}/pitch-reference/vocals").status_code
        == 404
    )


@pytest.mark.skipif(not _NATIVE_TRANSFORM, reason="FFmpeg and Rubber Band required")
def test_legacy_pitch_vocal_recovery_reuses_only_an_exact_cached_stem(
    client: TestClient,
    other_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    analysis = PitchAnalysis(
        2, 2, [PitchTrack("vocals", [PitchNote(0.2, 0.8, 69, 440, 0.9)])]
    )
    encoded = pitch_to_json(analysis)
    source_bytes = tone_wav((440,), duration_s=2)

    def submit_legacy_pitch_job() -> int:
        response = client.post(
            "/api/jobs",
            files={"file": ("song.wav", source_bytes, "audio/wav")},
            data={
                "detect_pitch": "true",
                "pitch_semitones": "12",
                "tempo_percent": "125",
            },
        )
        job_id = response.json()["id"]
        job = db.get_job(job_id)
        assert job is not None
        asyncio.run(queue._run_job(job))
        return job_id

    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    producer_calls = 0

    def spawn_pitch(*args: object, **kwargs: object) -> MagicMock:
        nonlocal producer_calls
        producer_calls += 1
        return MagicMock(object_id="fc-pitch")

    monkeypatch.setattr(modal_client, "spawn_with_lyrics", spawn_pitch)
    monkeypatch.setattr(
        modal_client, "poll", lambda *args: ProcessingResult({}, pitch_json=encoded)
    )
    job_id = submit_legacy_pitch_job()
    assert producer_calls == 1
    assert client.get(f"/api/jobs/{job_id}").json()["has_pitch_vocals"] is False

    model_cache = tmp_path / "models"
    model_path = model_cache / stems.VOCALS_STEM.model
    model_path.parent.mkdir(parents=True)
    model_path.write_bytes(b"cached vocal model")
    stem_cache = tmp_path / "stems"
    cache_calls: list[bytes] = []

    async def exact_cached_vocals(source: bytes) -> bytes | None:
        cache_calls.append(source)
        return stems.cached_pitch_vocals(source, str(model_cache), str(stem_cache))

    monkeypatch.setattr(modal_client, "cached_pitch_vocals", exact_cached_vocals)
    assert client.post(f"/api/jobs/{job_id}/pitch-reference/vocals").status_code == 404
    assert client.get(f"/api/jobs/{job_id}").json()["has_pitch_vocals"] is False
    assert cache_calls == [source_bytes]

    identity = stems._stem_identity(digest(source_bytes), stems.VOCALS_STEM)
    cache_id = cache_key(*identity, cache_versions.file_revision(model_path))
    archive_path = stem_cache / "versioned" / "outputs" / f"{cache_id}.bin"
    archive_path.parent.mkdir(parents=True)
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("vocals", source_bytes)

    recovered = client.post(f"/api/jobs/{job_id}/pitch-reference/vocals")
    assert recovered.status_code == 204
    assert cache_calls == [source_bytes, source_bytes]
    assert producer_calls == 1
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["has_pitch_vocals"] is True
    assert [entry["label"] for entry in payload["manifest"]] == ["song"]
    assert client.get(f"/api/jobs/{job_id}/results/vocals").status_code == 404
    reference = client.get(f"/api/jobs/{job_id}/pitch-reference/vocals")
    assert reference.status_code == 200
    duration, frequency = mp3_measurements(reference.content)
    assert duration == pytest.approx(2 / 1.25, abs=0.12)
    assert frequency == pytest.approx(880, rel=0.02)
    assert client.post(f"/api/jobs/{job_id}/pitch-reference/vocals").status_code == 204
    assert cache_calls == [source_bytes, source_bytes]
    assert producer_calls == 1

    model_path.write_bytes(
        b"changed model revision invalidates this exact cache archive"
    )
    changed_model_job_id = submit_legacy_pitch_job()
    assert producer_calls == 2
    assert (
        client.post(
            f"/api/jobs/{changed_model_job_id}/pitch-reference/vocals"
        ).status_code
        == 404
    )
    assert (
        client.get(f"/api/jobs/{changed_model_job_id}").json()["has_pitch_vocals"]
        is False
    )
    assert cache_calls == [source_bytes, source_bytes, source_bytes]
    assert producer_calls == 2
    assert (
        other_client.post(f"/api/jobs/{job_id}/pitch-reference/vocals").status_code
        == 404
    )
    assert (
        other_client.get(f"/api/jobs/{job_id}/pitch-reference/vocals").status_code
        == 404
    )


@pytest.mark.parametrize("archive_kind", ["corrupt", "missing-vocals"])
def test_unreadable_cached_vocal_archives_return_http_unavailable(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    archive_kind: str,
) -> None:
    analysis = PitchAnalysis(
        5, 5, [PitchTrack("vocals", [PitchNote(1, 2, 69, 440, 0.9)])]
    )
    encoded = pitch_to_json(analysis)
    source_bytes = b"original-upload-for-cache-key"
    response = client.post(
        "/api/jobs",
        files={"file": ("song.wav", source_bytes, "audio/wav")},
        data={"detect_pitch": "true"},
    )
    job_id = response.json()["id"]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        modal_client, "spawn_with_lyrics", lambda *args: MagicMock(object_id="fc-pitch")
    )
    monkeypatch.setattr(
        modal_client, "poll", lambda *args: ProcessingResult({}, pitch_json=encoded)
    )
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))

    model_cache = tmp_path / "models"
    model_path = model_cache / stems.VOCALS_STEM.model
    model_path.parent.mkdir(parents=True)
    model_path.write_bytes(b"present cached checkpoint")
    stem_cache = tmp_path / "stems"
    identity = stems._stem_identity(digest(source_bytes), stems.VOCALS_STEM)
    cache_id = cache_key(*identity, cache_versions.file_revision(model_path))
    archive_path = stem_cache / "versioned" / "outputs" / f"{cache_id}.bin"
    archive_path.parent.mkdir(parents=True)
    if archive_kind == "corrupt":
        archive_path.write_bytes(b"not a ZIP archive")
    else:
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("other-output", b"not vocal audio")

    async def read_exact_cache(audio_bytes: bytes) -> bytes | None:
        return stems.cached_pitch_vocals(audio_bytes, str(model_cache), str(stem_cache))

    monkeypatch.setattr(modal_client, "cached_pitch_vocals", read_exact_cache)
    recovery = client.post(f"/api/jobs/{job_id}/pitch-reference/vocals")
    assert recovery.status_code == 503
    assert client.get(f"/api/jobs/{job_id}").json()["has_pitch_vocals"] is False


def test_missing_analysis_fails_instead_of_fake_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = client.post(
        "/api/jobs", data={"url": "https://example.org/song", "detect_pitch": "true"}
    ).json()["id"]
    monkeypatch.setattr(
        queue, "_load_source_bytes", lambda *args: (b"source", "song.mp3")
    )
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        modal_client, "spawn_with_lyrics", lambda *args: MagicMock(object_id="fc-pitch")
    )
    monkeypatch.setattr(modal_client, "poll", lambda *args: ProcessingResult({}))
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))
    result = client.get(f"/api/jobs/{job_id}").json()
    assert result["status"] == "failed"
    assert result["error_message"] == "Pitch detection returned no analysis"
    assert result["pitch"] is None
    assert client.get(f"/api/jobs/{job_id}/pitch").status_code == 404


def test_new_processing_transport_contains_no_new_nested_pitch_classes() -> None:
    analysis = PitchAnalysis(5, 5, [PitchTrack("vocals", [])])
    result = ProcessingResult({}, pitch_json=pitch_to_json(analysis))
    encoded = pickle.dumps(result)
    assert b"PitchAnalysis" not in encoded
    assert b"PitchTrack" not in encoded
    restored = pickle.loads(encoded)
    assert pitch_from_json(restored.pitch_json) == analysis
    assert asdict(restored)["audio"] == {}
