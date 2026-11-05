"""Dependency-free ODF 1.2 export of the shared pitched-lyrics word-cell layout."""

import io
import re
import zipfile
from xml.etree import ElementTree as ET

from separator.pitched_lyrics import PitchedLyricsBlock, display_width

MIME_TYPE = "application/vnd.oasis.opendocument.text"
NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "fo": "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
    "svg": "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
    "manifest": "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0",
}
for prefix, namespace in NS.items():
    ET.register_namespace(prefix, namespace)


def _name(name: str) -> str:
    prefix, local = name.split(":")
    return f"{{{NS[prefix]}}}{local}"


def _element(parent: ET.Element, name: str, **attrs: str) -> ET.Element:
    return ET.SubElement(parent, _name(name), {_name(k): v for k, v in attrs.items()})


def _text(parent: ET.Element, value: str) -> None:
    # ODF collapses ordinary whitespace; text:s explicitly preserves every column.
    for part in re.split(r"( +)", value):
        if not part:
            continue
        if part.startswith(" "):
            _element(parent, "text:s", **{"text:c": str(len(part))})
        elif len(parent):
            parent[-1].tail = (parent[-1].tail or "") + part
        else:
            parent.text = (parent.text or "") + part


def _styled_text(parent: ET.Element, value: str, depth: int = 0) -> int:
    """Keep bracket styling across word-wrapped lyric continuation pairs."""
    start = 0
    for index, char in enumerate(value):
        if char == "[":
            if depth == 0:
                _text(parent, value[start:index])
                start = index
            depth += 1
        elif char == "]" and depth:
            depth -= 1
            if depth == 0:
                span = _element(parent, "text:span", **{"text:style-name": "Bracket"})
                _text(span, value[start : index + 1])
                start = index + 1
    if depth:
        span = _element(parent, "text:span", **{"text:style-name": "Bracket"})
        _text(span, value[start:])
    else:
        _text(parent, value[start:])
    return depth


def pitched_lyrics_odt(blocks: list[PitchedLyricsBlock]) -> bytes:
    # Whole-word cells are indivisible. Exceptionally long words/melismas use a
    # wider page rather than losing alignment or shrinking the readable font.
    columns = max(
        (
            max(display_width(block.text), display_width(block.pitch))
            for block in blocks
            if block.pitch is not None
        ),
        default=78,
    )
    page_width = max(21, (columns + 2) * 6 * 2.54 / 72 + 4)
    content = ET.Element(
        _name("office:document-content"), {_name("office:version"): "1.2"}
    )
    body = _element(_element(content, "office:body"), "office:text")
    bracket_depth = 0
    for block in blocks:
        if not block.continuation:
            bracket_depth = 0
        paragraph = _element(
            body,
            "text:p",
            **{"text:style-name": "Pair" if block.pitch is not None else "Heading"},
        )
        if block.pitch is not None:
            pitch = _element(paragraph, "text:span", **{"text:style-name": "Pitch"})
            _styled_text(pitch, block.pitch)
            _element(paragraph, "text:line-break")
        bracket_depth = _styled_text(paragraph, block.text, bracket_depth)

    styles = ET.Element(
        _name("office:document-styles"), {_name("office:version"): "1.2"}
    )
    faces = _element(styles, "office:font-face-decls")
    _element(
        faces,
        "style:font-face",
        **{
            "style:name": "Mono",
            "svg:font-family": "'Courier New'",
            "style:font-family-generic": "modern",
            "style:font-pitch": "fixed",
        },
    )
    # Western fixed cells are 6pt; full-width CJK glyphs must advance exactly
    # two cells (12pt), not an arbitrary same-point-size fallback's 10pt.
    _element(
        faces,
        "style:font-face",
        **{
            "style:name": "Wide",
            "svg:font-family": "'Noto Sans Mono CJK SC'",
            "style:font-family-generic": "modern",
            "style:font-pitch": "fixed",
        },
    )
    named = _element(styles, "office:styles")
    default = _element(named, "style:default-style", **{"style:family": "paragraph"})
    _element(
        default,
        "style:text-properties",
        **{
            "style:font-name": "Mono",
            "style:font-name-asian": "Wide",
            "style:font-name-complex": "Mono",
            "fo:font-size": "10pt",
            "style:font-size-asian": "12pt",
            "style:font-size-complex": "10pt",
            "fo:color": "#000000",
        },
    )
    _element(
        default,
        "style:paragraph-properties",
        **{
            "fo:line-height": "14pt",
            "fo:margin-top": "0pt",
            "fo:margin-bottom": "7pt",
            "style:text-autospace": "none",
        },
    )
    for name, properties in (
        ("Pair", {"fo:keep-together": "always"}),
        ("Heading", {"fo:keep-with-next": "always"}),
    ):
        style = _element(
            named, "style:style", **{"style:name": name, "style:family": "paragraph"}
        )
        _element(style, "style:paragraph-properties", **properties)
    for name, properties in (
        ("Pitch", {"fo:color": "#aaaaaa"}),
        (
            "Bracket",
            {
                "fo:font-weight": "bold",
                "style:font-weight-asian": "bold",
                "style:font-weight-complex": "bold",
            },
        ),
    ):
        style = _element(
            named, "style:style", **{"style:name": name, "style:family": "text"}
        )
        _element(style, "style:text-properties", **properties)
    automatic = _element(styles, "office:automatic-styles")
    layout = _element(automatic, "style:page-layout", **{"style:name": "Page"})
    _element(
        layout,
        "style:page-layout-properties",
        **{
            "fo:page-width": f"{page_width:.3f}cm",
            "fo:page-height": "29.7cm",
            "fo:margin": "2cm",
            "style:print-orientation": "portrait",
        },
    )
    masters = _element(styles, "office:master-styles")
    _element(
        masters,
        "style:master-page",
        **{"style:name": "Standard", "style:page-layout-name": "Page"},
    )

    manifest = ET.Element(
        _name("manifest:manifest"), {_name("manifest:version"): "1.2"}
    )
    for path, mime in (
        ("/", MIME_TYPE),
        ("content.xml", "text/xml"),
        ("styles.xml", "text/xml"),
    ):
        _element(
            manifest,
            "manifest:file-entry",
            **{"manifest:full-path": path, "manifest:media-type": mime},
        )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", MIME_TYPE, compress_type=zipfile.ZIP_STORED)
        for path, root in (
            ("content.xml", content),
            ("styles.xml", styles),
            ("META-INF/manifest.xml", manifest),
        ):
            archive.writestr(
                path, ET.tostring(root, encoding="utf-8", xml_declaration=True)
            )
    return output.getvalue()
