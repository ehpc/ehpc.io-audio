from backend.models import download_filename, original_filename


def test_download_filename_incorporates_title() -> None:
    assert (
        download_filename("Man On The Silver Mountain", 3, "vocals")
        == "Man On The Silver Mountain - vocals.mp3"
    )


def test_download_filename_strips_upload_extension() -> None:
    assert download_filename("song.mp3", 3, "instruments") == "song - instruments.mp3"


def test_download_filename_sanitizes_unsafe_characters() -> None:
    assert download_filename('a/b:c*?"<>|', 3, "vocals") == "abc - vocals.mp3"


def test_download_filename_falls_back_to_job_id_when_no_title() -> None:
    assert download_filename(None, 42, "vocals") == "42 - vocals.mp3"


def test_original_filename_keeps_real_extension() -> None:
    assert original_filename("Great Song", 3, ".mp3") == "Great Song - original.mp3"
    assert original_filename("clip.wav", 3, ".wav") == "clip - original.wav"


def test_original_filename_defaults_extension() -> None:
    assert original_filename(None, 5, "") == "5 - original.mp3"
