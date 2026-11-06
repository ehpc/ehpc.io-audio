import json
from typing import Any

import pytest

from backend import modal_client
from separator import song_search


@pytest.fixture
def version_rows():
    return [
        {
            "resultType": "song",
            "videoId": video_id,
            "title": title,
            "artists": [{"name": artist}],
            "duration_seconds": 240,
            "views": plays,
            "thumbnails": [{"url": f"https://i.ytimg.com/vi/{video_id}/default.jpg"}],
        }
        for video_id, title, artist, plays in [
            ("aaaaaaaaaaa", "Desired Song", "Desired Artist", "9M"),
            ("bbbbbbbbbbb", "Desired Song (Club Remix)", "Desired Artist", "100M"),
            ("ccccccccccc", "Desired Song (Live)", "Desired Artist", "1.2B"),
            ("ddddddddddd", "Desired Song", "Cover Artist", "9B"),
            ("eeeeeeeeeee", "Unrelated Song", "Desired Artist", "8B"),
            ("fffffffffff", "Desired Song (Radio Remix)", "Desired Artist", "0"),
            ("ggggggggggg", "Desired Song (Acoustic)", "Desired Artist", None),
            ("hhhhhhhhhhh", "Desired Song", "Desired Artist", "100M"),
        ]
    ]


def choose(rows, ids):
    return song_search.select_songs(
        json.dumps({"status": "match", "video_ids": ids}),
        song_search.catalog_candidates(rows),
    )


def test_popularity_ranks_only_relevant_versions_before_top_three(version_rows):
    songs = choose(
        version_rows,
        [
            "hhhhhhhhhhh",
            "ggggggggggg",
            "fffffffffff",
            "ccccccccccc",
            "bbbbbbbbbbb",
            "aaaaaaaaaaa",
        ],
    )
    assert [song["title"] for song in songs] == [
        "Desired Song (Live)",
        "Desired Song (Club Remix)",
        "Desired Song",
    ]
    assert [song["play_count"] for song in songs] == [
        1_200_000_000,
        100_000_000,
        100_000_000,
    ]
    assert [song["url"].rsplit("=", 1)[1] for song in songs] == [
        "ccccccccccc",
        "bbbbbbbbbbb",
        "hhhhhhhhhhh",
    ]
    # Higher-count covers/unrelated titles and the model's reversed order do not win.
    assert all(song["artists"] == ["Desired Artist"] for song in songs)


def test_explicit_version_selection_cannot_be_replaced_by_more_popular_recording(
    version_rows,
):
    songs = choose(version_rows, ["fffffffffff", "bbbbbbbbbbb"])
    assert [song["title"] for song in songs] == [
        "Desired Song (Club Remix)",
        "Desired Song (Radio Remix)",
    ]
    assert [song["play_count"] for song in songs] == [100_000_000, 0]


def test_zero_is_known_and_ties_follow_catalog_not_model_order(version_rows):
    rows = [
        dict(version_rows[0], views="0"),
        dict(version_rows[1], views=None),
        dict(version_rows[2], views="0"),
        dict(version_rows[3], views="unavailable"),
    ]
    songs = choose(rows, ["ddddddddddd", "ccccccccccc", "bbbbbbbbbbb", "aaaaaaaaaaa"])
    assert [song["url"].rsplit("=", 1)[1] for song in songs] == [
        "aaaaaaaaaaa",
        "ccccccccccc",
        "bbbbbbbbbbb",
    ]
    assert [song["play_count"] for song in songs] == [0, 0, None]
    assert all(song["play_count_approximate"] is False for song in songs)


def test_same_title_artist_duration_is_not_a_recording_identity(version_rows):
    # Distinct IDs can represent different recordings despite identical display data.
    rows = [version_rows[0], version_rows[7], dict(version_rows[0], views="9B")]
    songs = choose(rows, ["aaaaaaaaaaa", "hhhhhhhhhhh"])
    assert [song["url"].rsplit("=", 1)[1] for song in songs] == [
        "hhhhhhhhhhh",
        "aaaaaaaaaaa",
    ]
    assert [song["play_count"] for song in songs] == [100_000_000, 9_000_000]


@pytest.mark.parametrize(
    ("raw", "count", "approximate"),
    [
        ("9M", 9_000_000, True),
        ("100M", 100_000_000, True),
        ("2.7B", 2_700_000_000, True),
        ("7.9K", 7900, True),
        ("1.234K", 1234, True),
        ("1\u00a0M", 1_000_000, True),
        ("0", 0, False),
        (0, 0, False),
        ("1,234", 1234, False),
        ("9007199254740991", 9007199254740991, False),
        ("9007199254740992", None, False),
        ("1.2345K", None, False),
        ("12,34", None, False),
        ("1.2", None, False),
        ("1e9", None, False),
        ("-1", None, False),
        ("2.7B plays", None, False),
        ("\u0661M", None, False),
        ("9m", None, False),
        ("", None, False),
        (None, None, False),
        (True, None, False),
        (1.0, None, False),
        (float("nan"), None, False),
    ],
)
def test_catalog_plays_are_numeric_without_invented_precision(
    version_rows, raw, count, approximate
):
    row = dict(version_rows[0], views=raw)
    song = choose([row], ["aaaaaaaaaaa"])[0]
    assert song["play_count"] == count
    assert song["play_count_approximate"] is approximate


@pytest.mark.parametrize(
    "unsafe",
    [
        "http://i.ytimg.com/image.jpg",
        "https://evil.test/image.jpg",
        "https://yt3.googleusercontent.com.evil.test/image.jpg",
        "https://evil.test\\x.ytimg.com/image.jpg",
        "https://user:password@i.ytimg.com/image.jpg",
        "https://i.ytimg.com:444/image.jpg",
        "https://i.ytimg.com/image.jpg#fragment",
        "https://i.ytimg.com\n/image.jpg",
        "data:image/svg+xml,untrusted",
        None,
    ],
)
def test_untrusted_artwork_is_omitted_without_losing_grounded_song(
    version_rows, unsafe
):
    row = dict(version_rows[0], thumbnails=[{"url": unsafe}])
    song = choose([row], ["aaaaaaaaaaa"])[0]
    assert song["thumbnail_url"] is None
    assert song["url"] == "https://music.youtube.com/watch?v=aaaaaaaaaaa"


def test_artwork_uses_current_catalog_url_not_fabricated_or_model_metadata(
    version_rows,
):
    url = "https://yt3.googleusercontent.com/owned-public-artwork=w120-h120"
    row = dict(
        version_rows[0], thumbnails=[{"url": url}, {"url": "https://evil.test/x"}]
    )
    assert choose([row], ["aaaaaaaaaaa"])[0]["thumbnail_url"] == url
    for field, value in [("thumbnail_url", url), ("play_count", 9_000_000)]:
        with pytest.raises(song_search.SearchError) as error:
            song_search.select_songs(
                json.dumps(
                    {"status": "match", "video_ids": ["aaaaaaaaaaa"], field: value}
                ),
                song_search.catalog_candidates([row]),
            )
        assert error.value.code == "invalid_model"


def test_changed_popularity_and_artwork_reuse_relevance_inference(
    tmp_path, version_rows
):
    outputs = iter(
        [
            '{"search":"Desired Artist Desired Song"}',
            '{"status":"match","video_ids":["aaaaaaaaaaa","bbbbbbbbbbb"]}',
        ]
    )
    completions = 0
    rows = version_rows[:2]

    def complete(messages):
        nonlocal completions
        completions += 1
        return next(outputs)

    def run():
        return song_search.discover(
            "Find Desired Artist Desired Song",
            tmp_path,
            complete,
            lambda query: song_search.catalog_candidates(rows),
        )

    first = run()
    assert first[0]["title"] == "Desired Song (Club Remix)"
    new_artwork = "https://yt3.googleusercontent.com/new-cover=w120-h120"
    rows[0] = dict(rows[0], views="2.7B", thumbnails=[{"url": new_artwork}])
    second = run()
    assert second[0]["title"] == "Desired Song"
    assert second[0]["play_count"] == 2_700_000_000
    assert second[0]["thumbnail_url"] == new_artwork
    assert completions == 2  # Only initial extraction/selection, not metadata refresh.


def test_selection_bound_and_catalog_membership_do_not_expand_candidate_pool(
    version_rows,
):
    extra = dict(version_rows[0], videoId="iiiiiiiiiii", views="9B")
    candidates = song_search.catalog_candidates([*version_rows, extra])
    assert len(candidates) == 8
    selected = json.dumps(
        {"status": "match", "video_ids": [row["videoId"] for row in version_rows]}
    )
    assert len(song_search.select_songs(selected, candidates)) == 3
    for ids in [["iiiiiiiiiii"], [row["videoId"] for row in [*version_rows, extra]]]:
        with pytest.raises(song_search.SearchError) as error:
            song_search.select_songs(
                json.dumps({"status": "match", "video_ids": ids}), candidates
            )
        assert error.value.code == "invalid_model"


@pytest.fixture
def remote_versions(monkeypatch, version_rows):
    state: dict[str, Any] = {"spawns": 0, "polls": 0}
    state["result"] = {
        "status": "done",
        "songs": choose(version_rows, ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]),
    }

    async def spawn(query):
        state["spawns"] += 1
        return "fc-owned-version-fixture"

    async def poll(call_id):
        state["polls"] += 1
        return state["result"]

    monkeypatch.setattr(modal_client, "spawn_song_search", spawn)
    monkeypatch.setattr(modal_client, "poll_song_search", poll)
    return state


def test_plural_api_and_query_cache_preserve_metadata_and_private_handles(
    client, other_client, remote_versions
):
    response = client.post(
        "/api/song-search", json={"query": "Desired Artist Desired Song"}
    )
    assert response.status_code == 202
    path = "/api/song-search/" + response.json()["search_id"]
    assert other_client.get(path).status_code == 404
    result = client.get(path)
    assert result.status_code == 200
    assert [song["play_count"] for song in result.json()["songs"]] == [
        1_200_000_000,
        100_000_000,
        9_000_000,
    ]
    assert all(
        song["thumbnail_url"].startswith("https://i.ytimg.com/")
        for song in result.json()["songs"]
    )
    assert all(song["play_count_approximate"] for song in result.json()["songs"])
    hit = other_client.post(
        "/api/song-search", json={"query": " Desired Artist\nDesired Song "}
    )
    assert hit.status_code == 202
    cached_path = "/api/song-search/" + hit.json()["search_id"]
    assert client.get(cached_path).status_code == 404
    assert other_client.get(cached_path).json() == result.json()
    assert remote_versions["spawns"] == remote_versions["polls"] == 1
    assert client.get("/api/jobs").json() == other_client.get("/api/jobs").json() == []


@pytest.mark.parametrize(
    "invalid",
    [
        "empty",
        "too_many",
        "duplicate",
        "negative",
        "boolean",
        "fractional",
        "unsafe_integer",
        "unknown_approximation",
        "unsafe_artwork",
        "singular",
    ],
)
def test_invalid_version_response_is_never_published_as_success(
    client, remote_versions, invalid
):
    songs = remote_versions["result"]["songs"]
    if invalid == "empty":
        remote_versions["result"]["songs"] = []
    elif invalid == "too_many":
        remote_versions["result"]["songs"] = [*songs, songs[0]]
    elif invalid == "duplicate":
        remote_versions["result"]["songs"] = [songs[0], songs[0]]
    elif invalid == "singular":
        remote_versions["result"] = {"status": "done", "song": songs[0]}
    elif invalid == "unsafe_artwork":
        songs[0]["thumbnail_url"] = "https://evil.test/track-browser"
    elif invalid == "unknown_approximation":
        songs[0]["play_count"] = None
    else:
        songs[0]["play_count"] = {
            "negative": -1,
            "boolean": True,
            "fractional": 1.5,
            "unsafe_integer": 2**53,
        }[invalid]
    response = client.post("/api/song-search", json={"query": "Desired Song"})
    path = "/api/song-search/" + response.json()["search_id"]
    assert client.get(path).status_code == 502
    assert client.get(path).status_code == 502
    assert remote_versions["polls"] == 1
    # Invalid terminal rows must not become one-day successful query hits.
    assert (
        client.post("/api/song-search", json={"query": "Desired Song"}).status_code
        == 202
    )
    assert remote_versions["spawns"] == 2
