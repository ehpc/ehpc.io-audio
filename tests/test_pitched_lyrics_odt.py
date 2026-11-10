import io
import re
import shutil
import subprocess
import zipfile
from urllib.parse import unquote
from xml.etree import ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from backend import db, queue
from separator.lyrics import Transcript, TranscriptSegment, TranscriptWord
from separator.lyrics_reference import ReferenceLine, ReferenceReview
from separator.pitch import (
    PitchAnalysis,
    PitchNote,
    PitchTrack,
    pitch_to_json,
    transform_analysis,
)
from separator.pitched_lyrics import (
    LINE_COLUMNS,
    display_width,
    pitched_lyrics_document,
)
from separator.pitched_lyrics_odt import MIME_TYPE, NS, pitched_lyrics_odt
from tests.pitched_lyrics_odt_fixture import document_fixture, odf_text


def odf_properties(styles, element, inherited=None):
    """Resolve referenced style properties, including parents and paragraph defaults."""
    properties = {} if inherited is None else dict(inherited)
    if inherited is None:
        default = styles.find(
            "office:styles/style:default-style[@style:family='paragraph']", NS
        )
        if default is not None:
            for child in default:
                properties.update(child.attrib)
    name = element.get(f"{{{NS['text']}}}style-name")
    chain = []
    while name:
        style = styles.find(f"office:styles/style:style[@style:name='{name}']", NS)
        assert style is not None, f"unresolved referenced style {name}"
        chain.append(style)
        name = style.get(f"{{{NS['style']}}}parent-style-name")
    for style in reversed(chain):
        for child in style:
            properties.update(child.attrib)
    return properties


def odf_runs(styles, element, inherited=None):
    properties = odf_properties(styles, element, inherited)
    if element.text:
        yield element.text, properties
    for child in element:
        if child.tag == f"{{{NS['text']}}}s":
            yield " " * int(child.get(f"{{{NS['text']}}}c", "1")), properties
        elif child.tag == f"{{{NS['text']}}}line-break":
            yield "\n", properties
        else:
            yield from odf_runs(styles, child, properties)
        if child.tail:
            yield child.tail, properties


def bold_text(styles, element):
    return "".join(
        text
        for text, properties in odf_runs(styles, element)
        if properties.get(f"{{{NS['fo']}}}font-weight") == "bold"
    )


def grayscale(color):
    channels = [int(color[index : index + 2], 16) for index in (1, 3, 5)]
    assert max(channels) - min(channels) <= 1
    return sum(channels) / len(channels)


def test_odt_package_roundtrips_shared_pairs_spaces_unicode_and_styles() -> None:
    transcript, analysis = document_fixture()
    blocks = pitched_lyrics_document(
        transcript,
        analysis,
        analysis.tracks[0],
        title="Synthetic [ODT] <&>",
        output_key="C major",
    )
    data = pitched_lyrics_odt(blocks)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        first = archive.infolist()[0]
        assert (
            first.filename == "mimetype" and first.compress_type == zipfile.ZIP_STORED
        )
        assert archive.read("mimetype").decode() == MIME_TYPE
        manifest = ET.fromstring(archive.read("META-INF/manifest.xml"))
        entries = {
            item.get(f"{{{NS['manifest']}}}full-path"): item.get(
                f"{{{NS['manifest']}}}media-type"
            )
            for item in manifest
        }
        assert {
            "/": MIME_TYPE,
            "content.xml": "text/xml",
            "styles.xml": "text/xml",
        }.items() <= entries.items()
        content = ET.fromstring(archive.read("content.xml"))
        styles = ET.fromstring(archive.read("styles.xml"))
    paragraphs = content.findall("office:body/office:text/text:p", NS)
    assert len(paragraphs) == len(blocks)
    for block, paragraph in zip(blocks, paragraphs, strict=True):
        expected = block.text if block.pitch is None else f"{block.pitch}\n{block.text}"
        assert odf_text(paragraph) == expected
        assert len(paragraph.findall("text:line-break", NS)) == (
            block.pitch is not None
        )
        properties = odf_properties(styles, paragraph)
        if block.pitch is not None:
            assert properties[f"{{{NS['fo']}}}keep-together"] == "always"
            pitch_properties = odf_properties(styles, paragraph[0], properties)
            body_gray = grayscale(properties[f"{{{NS['fo']}}}color"])
            pitch_gray = grayscale(pitch_properties[f"{{{NS['fo']}}}color"])
            assert body_gray < pitch_gray < 255
            assert pitch_gray > (body_gray + 255) / 2
        else:
            assert properties[f"{{{NS['fo']}}}keep-with-next"] == "always"
        assert bold_text(styles, paragraph) == "".join(
            re.findall(r"\[[^\]]*\]", expected)
        )
        font_name = properties[f"{{{NS['style']}}}font-name"]
        face = styles.find(
            f"office:font-face-decls/style:font-face[@style:name='{font_name}']", NS
        )
        assert face is not None
        assert face.get(f"{{{NS['style']}}}font-pitch") == "fixed"
        assert face.get(f"{{{NS['style']}}}font-family-generic") == "modern"


def test_long_rows_wrap_only_between_cells_and_keep_timestamp_columns() -> None:
    transcript, analysis = document_fixture(1)
    blocks = pitched_lyrics_document(transcript, analysis, analysis.tracks[0])
    pairs = [block for block in blocks if block.pitch is not None]
    assert len(pairs) >= 3
    assert pairs[0].text.startswith("[100:00] pair000")
    assert pairs[0].pitch is not None
    assert pairs[0].pitch.startswith(" " * display_width("[100:00] ") + "C4 D4")
    for index, block in enumerate(pairs):
        assert block.pitch is not None
        assert all(
            display_width(row) <= LINE_COLUMNS for row in (block.text, block.pitch)
        )
        if index > 0:
            assert block.text.startswith(" " * 9)
            assert block.pitch.startswith(" " * 9)
        # No word/multiple-note cell can spill alone into a separate paragraph.
        assert "C4 D4" not in block.pitch or "pair000" in block.text
    assert (
        " ".join(block.text[9:].strip() for block in pairs).split()
        == transcript.segments[0].text.split()
    )
    unknown = Transcript(
        reference=ReferenceReview(
            "partial", "Synthetic", lines=[ReferenceLine("e\u0301 星光")]
        )
    )
    unknown_blocks = pitched_lyrics_document(unknown, analysis, analysis.tracks[1])
    pair = next(block for block in unknown_blocks if block.pitch is not None)
    assert pair.text == "[??:??] e\u0301  星光"
    assert pair.pitch == "        ?  ?"


def test_indivisible_long_melisma_uses_wider_page_not_split_notes_or_tiny_font() -> (
    None
):
    word = TranscriptWord(0, 40, "sustain")
    transcript = Transcript(
        segments=[TranscriptSegment(0, 40, word.text)], words=[word]
    )
    analysis = transform_analysis(
        PitchAnalysis(
            40,
            40,
            [
                PitchTrack(
                    "lead", [PitchNote(i, i + 1, 60, 261, 0.9) for i in range(40)]
                )
            ],
        ),
        0,
        100,
        [word],
    )
    blocks = pitched_lyrics_document(transcript, analysis, analysis.tracks[0])
    assert len(blocks) == 1
    assert blocks[0].pitch == "        " + " ".join(["C4"] * 40)
    with zipfile.ZipFile(io.BytesIO(pitched_lyrics_odt(blocks))) as archive:
        styles = ET.fromstring(archive.read("styles.xml"))
    normal_transcript, normal_analysis = document_fixture(1)
    normal_blocks = pitched_lyrics_document(
        normal_transcript, normal_analysis, normal_analysis.tracks[0]
    )
    with zipfile.ZipFile(io.BytesIO(pitched_lyrics_odt(normal_blocks))) as archive:
        normal_styles = ET.fromstring(archive.read("styles.xml"))

    def page_width(root):
        page = root.find(
            "office:automatic-styles/style:page-layout/style:page-layout-properties", NS
        )
        return float(page.get(f"{{{NS['fo']}}}page-width").removesuffix("cm"))

    assert page_width(styles) > page_width(normal_styles)
    properties = styles.find(
        "office:styles/style:default-style/style:text-properties", NS
    )
    normal_properties = normal_styles.find(
        "office:styles/style:default-style/style:text-properties", NS
    )
    assert properties is not None and normal_properties is not None
    assert properties.get(f"{{{NS['fo']}}}font-size") == normal_properties.get(
        f"{{{NS['fo']}}}font-size"
    )


@pytest.mark.parametrize("label", ["lead", "backing"])
def test_private_http_odt_uses_stored_job_current_layout_and_stem(
    client: TestClient, other_client: TestClient, label: str
) -> None:
    transcript, analysis = document_fixture(1)
    response = client.post(
        "/api/jobs",
        data={"url": "https://example.org/synthetic", "extract_pitched_lyrics": "true"},
    )
    job_id = response.json()["id"]
    db.mark_done(job_id, [], transcript, pitch_to_json(analysis))
    db.set_title(job_id, "Synthetic [proof]")
    db.set_original_key(job_id, "C major")
    path = f"/api/jobs/{job_id}/pitched-lyrics/{label}/download"
    response = client.get(path, params={"format": "odt"})
    assert response.status_code == 200
    assert response.headers["content-type"] == MIME_TYPE
    assert f"Synthetic [proof] - {label} - lyrics-with-pitches.odt" in unquote(
        response.headers["content-disposition"]
    )
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        body = ET.fromstring(archive.read("content.xml"))
    paragraphs = body.findall("office:body/office:text/text:p", NS)
    text = "".join(
        odf_text(p) + ("\n\n" if p.find("text:line-break", NS) is not None else "\n")
        for p in paragraphs
    )
    assert (
        text == client.get(path).text == client.get(path, params={"format": "txt"}).text
    )
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert text == next(
        track["text"] for track in payload["pitched_lyrics"] if track["label"] == label
    )
    assert (
        next(
            track["wide_characters"]
            for track in payload["pitched_lyrics"]
            if track["label"] == label
        )
        == "光星"
    )
    assert odf_text(paragraphs[0]) == "Synthetic [proof]"
    assert any("C major" in odf_text(paragraph) for paragraph in paragraphs)
    assert ("C4 D4" in text) == (label == "lead")
    assert other_client.get(path, params={"format": "odt"}).status_code == 404
    assert client.get(path, params={"format": "pdf"}).status_code == 422
    assert (
        client.get(path.replace(label, "absent"), params={"format": "odt"}).status_code
        == 404
    )
    job = db.get_job(job_id)
    assert job is not None
    assert job.transcript == transcript and job.pitch_json == pitch_to_json(analysis)


def test_historical_karaoke_exports_saved_analysis_without_reprocessing(
    client: TestClient, other_client: TestClient, monkeypatch
) -> None:
    def no_processing(*_args, **_kwargs):
        raise AssertionError("reading saved lyrics must not process the source")

    monkeypatch.setattr(queue, "process_source", no_processing)
    transcript, analysis = document_fixture(1)
    response = client.post(
        "/api/jobs",
        data={
            "url": "https://example.org/synthetic",
            "detect_pitch": "true",
            "extract_lyrics": "true",
        },
    )
    job_id = response.json()["id"]
    db.mark_done(job_id, [], transcript, pitch_to_json(analysis))
    db.set_title(job_id, "Synthetic [proof]")
    db.set_original_key(job_id, "C major")
    saved = db.get_job(job_id)
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["options"]["extract_pitched_lyrics"] is False
    track = next(t for t in payload["pitched_lyrics"] if t["label"] == "lead")
    path = f"/api/jobs/{job_id}/pitched-lyrics/lead/download"
    txt = client.get(path)
    odt = client.get(path, params={"format": "odt"})
    assert txt.status_code == odt.status_code == 200
    assert txt.content.decode("utf-8") == track["text"]
    assert odt.headers["content-type"] == MIME_TYPE
    with zipfile.ZipFile(io.BytesIO(odt.content)) as archive:
        body = ET.fromstring(archive.read("content.xml"))
    paragraphs = body.findall("office:body/office:text/text:p", NS)
    odt_text = "".join(
        odf_text(p) + ("\n\n" if p.find("text:line-break", NS) is not None else "\n")
        for p in paragraphs
    )
    assert odt_text == track["text"]
    assert "Synthetic [proof]" in odt_text and "C major" in odt_text
    assert "C4 D4" in odt_text and "光" in odt_text
    assert re.search(r"\[\d+:\d{2}\]", odt_text)
    assert other_client.get(path).status_code == 404
    assert other_client.get(path, params={"format": "odt"}).status_code == 404
    assert client.get(path.replace("lead", "absent")).status_code == 404
    assert db.get_job(job_id) == saved


@pytest.mark.parametrize("missing", ["transcript", "pitch"])
def test_karaoke_exports_require_both_saved_inputs(
    client: TestClient, missing: str
) -> None:
    transcript, analysis = document_fixture(1)
    response = client.post(
        "/api/jobs",
        data={"url": "https://example.org/synthetic", "detect_pitch": "true"},
    )
    job_id = response.json()["id"]
    db.mark_done(
        job_id,
        [],
        None if missing == "transcript" else transcript,
        None if missing == "pitch" else pitch_to_json(analysis),
    )
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["pitched_lyrics"] is None
    path = f"/api/jobs/{job_id}/pitched-lyrics/lead/download"
    assert client.get(path).status_code == 404
    assert client.get(path, params={"format": "odt"}).status_code == 404


@pytest.mark.parametrize("oversized", [False, True])
def test_libreoffice_rendered_pagination_columns_gray_and_bold(
    tmp_path, oversized
) -> None:
    """Opt-in real consumer test: uv run --with pymupdf pytest ... -k libreoffice."""
    fitz = pytest.importorskip("pymupdf")
    executable = shutil.which("libreoffice")
    if executable is None:
        pytest.skip("LibreOffice is required for the rendered ODT integration test")
    if oversized:
        word = TranscriptWord(0, 40, "sustain")
        transcript = Transcript(
            segments=[TranscriptSegment(0, 40, word.text)], words=[word]
        )
        analysis = transform_analysis(
            PitchAnalysis(
                40,
                40,
                [
                    PitchTrack(
                        "lead", [PitchNote(i, i + 1, 60, 261, 0.9) for i in range(40)]
                    )
                ],
            ),
            0,
            100,
            [word],
        )
    else:
        transcript, analysis = document_fixture()
    blocks = pitched_lyrics_document(
        transcript,
        analysis,
        analysis.tracks[0],
        title="Synthetic [echo] echo",
        output_key="C major",
    )
    source = tmp_path / "multipage.odt"
    source.write_bytes(pitched_lyrics_odt(blocks))
    subprocess.run(
        [
            executable,
            f"-env:UserInstallation={tmp_path.as_uri()}/lo-profile",
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            str(tmp_path),
            str(source),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    document = fitz.open(source.with_suffix(".pdf"))
    assert len(document) == 1 if oversized else 1 < len(document) < len(blocks) // 2
    title_chars = [
        char
        for span in document[0].get_text("rawdict")["blocks"][0]["lines"][0]["spans"]
        for char in span["chars"]
    ]
    cell_width = title_chars[1]["origin"][0] - title_chars[0]["origin"][0]
    assert cell_width > 0

    def raster_ink(page, span):
        x, y = span["origin"]
        x += (len(span["text"]) - len(span["text"].lstrip())) * cell_width
        size = span["size"]
        pixels = page.get_pixmap(
            matrix=fitz.Matrix(3, 3),
            clip=fitz.Rect(x, y - size, x + 2 * cell_width, y + size / 10),
            colorspace=fitz.csRGB,
        )
        samples = pixels.samples
        darkest = min(
            zip(samples[::3], samples[1::3], samples[2::3], strict=True), key=sum
        )
        assert max(darkest) - min(darkest) <= 1
        return sum(darkest) / 3

    expected = iter(blocks)
    current = next(expected)
    pair_count = 0
    for page_index, page in enumerate(document):
        lines = [
            line
            for block in page.get_text("dict")["blocks"]
            for line in block.get("lines", [])
        ]
        index = 0
        while index < len(lines):
            line = lines[index]
            rendered = "".join(span["text"] for span in line["spans"])
            assert current is not None
            assert rendered == (
                current.pitch if current.pitch is not None else current.text
            )
            if current.pitch is not None:
                # A pair must have both rows on this page, including its last pair.
                assert index + 1 < len(lines)
                lyric = lines[index + 1]
                assert "".join(span["text"] for span in lyric["spans"]) == current.text
                assert lyric["spans"][0]["origin"][1] > line["spans"][0]["origin"][1]
                for row in (line, lyric):
                    columns = 0
                    left = row["spans"][0]["origin"][0]
                    for span in row["spans"]:
                        assert span["origin"][0] == pytest.approx(
                            left + columns * cell_width, abs=0.1
                        )
                        columns += display_width(span["text"])
                pitch_span = next(
                    span for span in line["spans"] if span["text"].strip()
                )
                lyric_span = next(
                    span for span in lyric["spans"] if span["text"].strip()
                )
                pitch_ink = raster_ink(page, pitch_span)
                body_ink = raster_ink(page, lyric_span)
                assert body_ink < pitch_ink < 255
                assert pitch_ink > (body_ink + 255) / 2
                pair_count += 1
                index += 1
            index += 1
            current = next(expected, None)
        page.get_pixmap(matrix=fitz.Matrix(1.3, 1.3)).save(
            tmp_path / f"page-{page_index + 1}.png"
        )
    assert current is None and pair_count == sum(
        block.pitch is not None for block in blocks
    )
    # LibreOffice may synthesize bold for variable fonts. Check the actual ink,
    # not merely font-name metadata: identical glyphs must become visibly heavier.
    title = document[0].get_text("dict")["blocks"][0]["lines"][0]["spans"]
    bold = next(span for span in title if span["text"] == "[echo]")
    regular = next(span for span in title if span["text"].strip() == "echo")

    def dark_ink(span, skip_columns):
        x, y = span["origin"]
        size = span["size"]
        pixels = document[0].get_pixmap(
            matrix=fitz.Matrix(4, 4),
            clip=fitz.Rect(
                x + skip_columns * cell_width,
                y - size,
                x + (skip_columns + 4) * cell_width,
                y + size / 10,
            ),
            colorspace=fitz.csGRAY,
        )
        return sum(255 - value for value in pixels.samples)

    assert (
        dark_ink(bold, 1)
        > dark_ink(regular, len(regular["text"]) - len(regular["text"].lstrip())) * 1.2
    )


def test_square_brackets_remain_bold_across_shared_wrapped_pairs() -> None:
    words = [f"inside{index:02d}" for index in range(30)]
    transcript = Transcript(
        reference=ReferenceReview(
            "partial",
            "Synthetic",
            lines=[ReferenceLine("[" + " ".join(words) + "] outside")],
        )
    )
    analysis = PitchAnalysis(1, 1, [PitchTrack("lead", [])])
    blocks = pitched_lyrics_document(transcript, analysis, analysis.tracks[0])
    assert len([block for block in blocks if block.pitch is not None]) > 3
    with zipfile.ZipFile(io.BytesIO(pitched_lyrics_odt(blocks))) as archive:
        content = ET.fromstring(archive.read("content.xml"))
        styles = ET.fromstring(archive.read("styles.xml"))
    bold_content = bold_text(styles, content)
    assert all(word in bold_content for word in words)
    assert "[??:??]" in bold_content and "outside" not in bold_content


@pytest.mark.parametrize(
    "title,first_line",
    [
        ("Unclosed [title", "ordinary first"),
        ("Ordinary title", "[unclosed first"),
    ],
)
def test_unclosed_brackets_do_not_style_unrelated_headers_or_lyric_lines(
    title, first_line
):
    transcript = Transcript(
        reference=ReferenceReview(
            "partial",
            "Synthetic",
            lines=[ReferenceLine(first_line), ReferenceLine("ordinary second")],
        )
    )
    analysis = PitchAnalysis(1, 1, [PitchTrack("lead", [])])
    blocks = pitched_lyrics_document(
        transcript,
        analysis,
        analysis.tracks[0],
        title=title,
        output_key="C major",
    )
    with zipfile.ZipFile(io.BytesIO(pitched_lyrics_odt(blocks))) as archive:
        content = ET.fromstring(archive.read("content.xml"))
        styles = ET.fromstring(archive.read("styles.xml"))
    paragraphs = content.findall("office:body/office:text/text:p", NS)
    for block, paragraph in zip(blocks, paragraphs, strict=True):
        if "C major" in block.text:
            assert not bold_text(styles, paragraph)
        if "ordinary" in block.text:
            assert bold_text(styles, paragraph) == "[??:??]"
