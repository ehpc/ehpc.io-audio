# ehpc's Vocal Tools

A web app for downloading a song, transforming its pitch/tempo, extracting
selected vocal and instrument tracks or timestamped lyrics, and detecting
vocal melody notes. Submit a URL or upload a file: by default, only the original
song is kept, with **no GPU separation or pitch/lyrics inference**. Explicitly
choose the audio outputs, lyrics, or vocal pitch analysis you want.
Multiple people can use it at once; submissions go through a queue, and each
visitor sees their live position.

## Architecture

```
                 ┌─────────────────────────── one container / one pod ───────────────────────────┐
                 │                                                                                 │
 Browser  ──────►│  backend/ (FastAPI + uvicorn, :8000)                                            │
 (SolidJS UI,     │    ├─ serves frontend/dist/ as static files (same origin, same port)            │
  built into      │    ├─ REST + SSE API under /api                                                 │
  frontend/dist)  │    ├─ SQLite (single writer) — job queue + status, on a mounted volume           │
                 │    └─ in-process asyncio worker pool ─────┐                                     │
                 │                                            │                                     │
                 └────────────────────────────────────────────┼─────────────────────────────────────┘
                                                                │
                                                                ▼
                                                  separator/modal_app.py ("audio-separator-v2" Modal app)
                                                                │
                                                                ▼
                                                   GPU container (separation + optional lyrics/pitch)
```

- **`separator/`** — pure domain logic (stem-model configs, the actual
  separation pipeline, URL download, and CPU audio analysis/postprocessing)
  plus `modal_app.py`, which defines Modal GPU functions for separation and
  optional lyric/pitch analysis, and CPU song discovery. All four functions
  (`healthcheck`, `separate`, `separate_with_lyrics`, `search_song`) live in
  `ehpc` workspace / `ehpc-audio` environment / `audio-separator-v2` app.
  It owns the CUDA images and GPU-only dependencies.
- **`backend/`** — the always-on FastAPI app. It downloads/reads the source and
  detects its key with libkeyfinder. Download-only jobs and whole-song pitch/tempo
  changes run locally, without calling Modal.
  Normal separation uses the existing `separate` Modal call; lyrics or vocal-pitch
  jobs use the backward-compatible `separate_with_lyrics` analysis RPC alongside
  any requested stems. Rubber Band R3 applies pitch/tempo changes locally to each
  final audio output, after any mixing. A small SQLite-backed queue caps
  concurrent jobs.

- **`frontend/`** — SolidJS + Vite + Tailwind + Solid UI. Built to static
  assets at image-build time and served by the backend from the same origin,
  so there's exactly one port to expose.
- Users are identified by an anonymous, signed HTTP-only cookie (no login).
  State survives a page reload because the frontend re-derives "what's my
  current job" from the backend on mount, rather than storing it client-side.
- **SSE job updates** send comment heartbeats every 15 seconds, with
  `Cache-Control: no-cache` and `X-Accel-Buffering: no`, so quiet, long-running
  jobs keep their live status stream open through proxies. The stream subscribes
  before reading its fresh initial status snapshot to avoid missing a terminal
  update that races with connection setup, and unsubscribes when it closes.

### Persistent artifact reuse

Reusable work is never bypassed by a request flag (`no_cache` was removed in
options schema 3). The production app name remains `audio-separator-v2`;
its environment is `ehpc-audio`. Independent producer versions live in
`separator/cache_versions.py`; changing UI, documentation, a mix name, pitch, or
tempo does not invalidate recognition, alignment, source pitch, or raw stems.
Relevant native executable/package revisions and model identities participate
in each producer key. Model-file digests are memoized by file identity/mtime,
not reread for every request. There is no TTL or global release/Git-SHA key.

The web data volume stores private `artifacts/sources`, `key-decode`, `keys`,
and `transforms` files. YouTube aliases use the video ID (different video/version
IDs remain distinct); other URLs retain their full identity. The first download,
including key preview, captures artist/track metadata. Each job receives its own
original-byte copy; output title tags never mutate a shared source. Key preview
and processing share decoded-audio analysis, including a valid unknown (`null`)
result. Uploaded filenames and browser sessions do not enter content keys.

The model volume stores versioned stems, mixes, `analysis-results` (lyrics,
structure, source-clock pitch), and Qwen `results` (raw recognition and MMS
recognition alignment). A hit is checked before spawning a neural subprocess;
raw Qwen output survives reference/alignment changes. New pitch/tempo requests
project source-clock data and cache their native transformed audio separately.
Baseline MMS alignment keys include decoded PCM, sample rate, raw recognition,
and aligner model/dependency identity. Changed decoded acoustics invalidate its
timings even if recognized words stay identical; container metadata or Qwen-only
dependency changes do not invalidate alignment when PCM and raw chunks agree.
Custom mix IDs/names do not enter audio keys. Successful LRCLIB records retain
their existing exact-version cache and are revalidated before use.

Files publish atomically only after successful producer validation. Per-key
filesystem locks coalesce local processes; the backend serializes same-source
remote work until its model-volume artifacts commit, and the next remote call
reloads that volume. Cancellation while waiting for a source lock is nonblocking.
Caches are internal, not new public routes, job-history sharing, or API telemetry.
Existing job files remain readable. Old unversioned analysis/stem artifacts lack
sufficient producer provenance and are not silently relabeled as current Qwen,
alignment, or model output: their first current-version use recomputes once.

Cache regression proofs use owned synthetic audio and explicitly versioned CPU
analysis fixtures, not claimed neural-quality substitutes. They observe real
producer calls, forbid recomputation on hits, exercise independent stage-version
changes and process restarts, and verify private HTTP results/history. The
CPU-only Modal smoke uses a private ephemeral volume to check actual FUSE locks,
atomic publication, commit/reload visibility, cancelled waiters, and preserved
audio duration. Existing successful neural-quality proofs are not rerun merely
to check cache hits. Genuine reference-text changes reuse raw recognition and
baseline alignment but may require fresh reference-dependent acoustic alignment.

### Text-assisted YouTube Music discovery

`POST /api/song-search` accepts `{"query":"artist, title, or lyric clue"}` and
returns HTTP 202 `{"search_id":"opaque ID","status":"pending"}` after spawning
remote work, not after provider inference. `GET /api/song-search/{search_id}` returns
`{"status":"pending"}` or `{"status":"done","song":{"title":"…","artists":["…"],
"url":"https://music.youtube.com/watch?v=…","duration_seconds":214}}`.
Duration may be `null`. Poll every two seconds; polls retrieve the existing call
with zero inference wait and never spawn another model request. Browser voice
input is browser dictation into this same text field, not server audio upload.

Whitespace is normalized; the 500-character limit admits a spoken paragraph
while bounding model input (not whole lyrics/documents). Search does not create
audio jobs, download music, or change processing options. Selecting its grounded
URL feeds the existing source/key-preview workflow; processing still requires
the normal explicit submission.

The additive, idempotent SQLite `song_searches` table stores opaque random IDs,
session ownership, Modal call ID, creation time and terminal JSON results/errors;
it does not store the query. Existing `jobs`, options, manifests and artifacts
are unchanged. Handles expire after 15 minutes and require the originating
signed session cookie, including after process restart. Foreign, unknown and
expired handles return 404 without contacting Modal. No match is 404; ambiguity
is 422; malformed model/catalog output is 502; remote unavailability is 503.
Errors use the usual `{"detail":"…"}` envelope. Completed polls read durable
terminal state; closing the browser stops polling but does not cancel remote work.

`search_song` runs on an **independent Python 3.13 CPU** Modal image, without
changing separator or singing-ASR GPU dependencies. Both text extraction and
catalog selection use [OpenRouter chat completions](https://openrouter.ai/docs/api/reference/overview)
with the explicit model `z-ai/glm-4.7-flash` (listed in the
[public model catalog](https://openrouter.ai/api/v1/models/z-ai/glm-4.7-flash/endpoints)).
Requests use JSON mode, temperature zero and at most 256 output tokens.
GLM's optional default-on thinking is explicitly disabled using OpenRouter's
[reasoning control](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
so reasoning does not consume the small visible-JSON budget.
Only endpoints supporting those parameters are eligible; normal OpenRouter
provider routing/account preferences remain in effect. There are no application
retries, alternate-model fallbacks or local text-model loaders.

Before deployment, create the dedicated **`audio-openrouter` Modal Secret** in
the **`ehpc-audio` environment** of the existing `ehpc` workspace using the
[Modal Dashboard](https://modal.com/secrets), containing **`OPENROUTER_API_KEY`**
from the application's authorized OpenRouter account. The app, its volumes,
and this secret resolve in the same `ehpc-audio` deployment environment.
Never paste the key into chat, commit it, or reuse coding-assistant credentials.
The secret is attached only to the search function; no web-container/provider
key or frontend configuration is needed. Account credits and provider access
must permit this model. Missing credentials or authentication/billing/rate-limit
failures return a safe 503 error. HTTP requests have 5-second connect and
30-second read timeouts; redirects are rejected and provider response bodies
are not exposed in public errors. Search clues and candidate metadata are sent
to OpenRouter and its selected model provider, but not browser/session IDs,
audio bytes, job history or application credentials in prompt content.
The model extracts supplied clues into search text (validated not to invent
artist/title words), then selects strictly from fresh public YouTube Music
**song** candidates via `ytmusicapi==1.11.5`. Lyric clues go to catalog search
as lyrics, not a model's guessed artist. Catalog HTTP
connect/read timeouts are 5/15 seconds; the remote function is capped at 180
seconds. User and catalog text are untrusted prompt data. The model cannot
supply URLs, metadata or uncatalogued IDs; invalid selections/abstentions fail
explicitly, never falling back to the first song.

The existing `audio-song-discovery` Modal volume stores versioned, validated
inference artifacts. Keys include the explicit model, OpenRouter endpoint,
HTTP dependency revision, inference/prompt version and complete prompt/candidate
inputs. Provider calls happen only on cache misses. The new producer identity
does not reuse previous local-model inference; unused historical model files
are left untouched, not deleted. Catalog searches themselves are always fresh,
so mutable catalog results are not frozen indefinitely; candidate changes
invalidate only selection inference. Discovery never invalidates audio caches.

## Choosing outputs

The original source remains downloadable and unchanged by processing, preserving
the uploaded file's extension. URL downloads retain the existing yt-dlp MP3
workflow. A completed job with no generated audio has an empty result manifest;
its original download remains available in Results and History. Lyrics are a
separate optional text output and do not create an audio stem.

Each generated MP3 embeds a `Title` tag identical to its canonical download
filename without the `.mp3` extension. This title includes the output stem and
any source-key, pitch, and tempo descriptors present in the filename. If the
source key is unknown, no source-key descriptor or placeholder is added. The
original download is never retagged; its bytes remain unchanged.

When **Extract lyrics** is selected, the worker looks up an exact-version lyric
reference from credible music metadata, independently recognizes the full source
vocals with [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B), and
aligns supported reference phrases to the actual audio with MMS CTC. Missing
metadata or a provider outage uses the new unprompted recognizer without a
reference. This is **reference-aligned candidate text, not verified lyrics**:
conflicting variants, unconfirmed lines and unsupported word timings remain
explicit. See [reference-first lyrics](#reference-first-lyrics-and-audio-alignment).
Internal vocal prerequisites do not become selected audio outputs, and ordinary
download-only remains the no-GPU default.

Results and History share a timestamped UTF-8 TXT and canonical provenance JSON.
The TXT opens with an `Artist — Track` identity line — reference metadata when
present, otherwise the job's presentation title, and omitted when neither
exists. Undetectable onsets render the `[??:??]` token; no invented timestamp,
header legend or bottom uncertainty block is appended. TXT onsets are floored to
whole seconds on the original audio clock; JSON retains
approximate measured word intervals, not exact syllable/karaoke boundaries.
Failed alignment preserves raw recognition and explicitly untimed text instead
of inventing a word onset at the beginning of a decoding window. The source
language is not translated. Qwen documents 30 recognition languages, narrower
than the previous Whisper language coverage; this is not a 99-language promise.
Empty recognition still displays estimated musical-section headers without
inventing lyrics.
Musical structure estimation is experimental and may be inaccurate. It uses
[SongFormer](https://github.com/ASLP-lab/SongFormer/tree/a75880ed1b7375ac71860ec6c4fc9c899cf99515)
([CC-BY-4.0 license](https://github.com/ASLP-lab/SongFormer/blob/a75880ed1b7375ac71860ec6c4fc9c899cf99515/LICENSE))
and incorporates [MuQ](https://github.com/tencent-ailab/MuQ) embeddings with
[CC-BY-NC-4.0 weights](https://huggingface.co/OpenMuQ/MuQ-large-msd-iter).
The MuQ weights' noncommercial license requires separate rights for commercial
use. This project's authorized use includes noncommercial local development,
runtime verification, and deployment of this personal music tool; that project
authorization does not grant additional rights under the model licenses.


| Selection | Output label or file |
|---|---|
| Extract vocals | `vocals` |
| Extract lyrics | Timestamped TXT and lyrics/provenance JSON (original audio clock) |
| Detect vocal pitch | Musical-note timeline and pitch JSON (output audio clock) |
| Lyrics with pitches | Aligned pitch-over-word TXT/ODT per vocal stem, also shown in Results/History (output audio clock) |
| Extract instruments | `instruments` |
| Remove crowd noise from vocals | `vocals-decrowded` |
| Remove crowd noise from instrumental | `instruments-decrowded` |
| Split by gender | `vocals-male`, `vocals-female` |
| Split lead & backing | `lead`, `backing` |
| Split drums, bass & other instruments | `drums`, `bass`, `other-instruments` |
| Custom mix | One named audio file per saved mix (`mix-1`, `mix-2`, … internal IDs) |

- Cleanup/split outputs work without selecting their parent extraction. Required
  intermediate tracks are internal unless their own output is selected.
- In Mixes, choose any two or more of Drums, Bass, Vocals, Other instruments,
  Instruments, Female vocals, Male vocals, Lead vocals and Backing vocals.
  Save multiple mixes, edit their automatic names or components, or remove them.
  Outputs and Splits select separate downloads, never mix ingredients.
  Instruments includes drums, bass and other instruments; Vocals includes its
  variants. Overlapping ingredients are allowed and are summed, not deduplicated.
  Original audio and previous mix outputs are not ingredients.
- Dereverb adds a `-dry` counterpart to each selected vocal output. **Dereverb
  alone**, with no other output selection, produces only `vocals-dry`.
  Instrument-only + dereverb does not add a vocal track. Mix-only + dereverb
  dries the mix's vocal prerequisite without exposing a standalone dry track.
- Vocal splits use decrowded vocals when vocal crowd removal is selected.
  Mixes use cleaned vocals/splits, their dry versions when dereverb is selected,
  and decrowded instruments when instrumental crowd removal is selected.
  Drums/bass/other extraction also uses the selected cleaned instrumental source.
- Lead vocals + instruments omits backing vocals, using the existing lead/backing
  split. Its vocal and instrumental prerequisites stay hidden unless selected.
- Download order is vocal wet/dry pairs (`vocals`, decrowded vocals, male,
  female, lead, backing), then instrumental outputs, then mixes in saved order.
  A shared prerequisite/model pass runs only once. Instrument-only mixes do not
  invoke the vocal model unless another selected feature needs vocals.
- Mixes are simultaneous audio sums, not concatenations: FFmpeg aligns all
  inputs to stereo/48 kHz and sums at unity gain (`amix normalize=0`). A
  latency-compensated peak limiter with **no automatic makeup gain** reduces only
  excessive peaks; its 0.89 ceiling leaves about 1 dB of MP3 reconstruction
  headroom. Quiet passages are not averaged down or automatically boosted.
  Mixing precedes pitch/tempo rendering, and separation caches remain raw.
- Stored jobs from before explicit extraction are migrated to request both base
  stems, preserving their history and retry behavior.
- Historical fixed-mix options are converted once in stored options JSON. Existing
  result manifests, labels, filenames, audio and analysis data are untouched:
  old download URLs remain valid. Retrying an old job uses its converted mixes.
  Names may repeat; stable IDs distinguish outputs even when names sanitize alike.

The multipart API accepts `mixes` as a JSON array (default `[]`), for example:

```json
[{"id":"mix-1","name":"Rhythm","components":["drums","bass"]},
 {"id":"mix-2","name":"Band and voice","components":["drums","bass","vocals"]}]
```

Each object has exactly `id`, `name`, and `components`. Component IDs are `drums`,
`bass`, `vocals`, `other`, `instruments`, `female`, `male`, `lead`, and `backing`;
at least two distinct entries are required. IDs match
`^mix-[a-z0-9][a-z0-9-]{0,47}$` and are unique within a job. Names are trimmed,
1–120 characters, without control characters. Unknown form fields and invalid
mixes return HTTP 422 without inserting a job; the removed fixed-mix request
booleans are not accepted. Result labels/internal filenames use stable IDs;
`manifest.display_name` carries the editable name. Public filenames and MP3 Title
tags share one canonical name with sanitized mix name, ID, source key, pitch and
tempo qualifiers. Results/History use the same saved identity and display name.

### Responsive workspace

Desktop uses a broad two-by-two shelf of Outputs, Mixes, Cleanup and Splits, with
pitch, tempo, original/target keys and notes, output preview and submission in a
dedicated right rail. Desktop body/control text scales from 16px to 18px on wide
screens and 20px at 3000px and above; Results and History typography scales with
it. At widths up to 700px, the same controls become **Outputs / Adjust / Review**
tabs; changing tabs never resets processing choices, pitch, tempo or key analysis.
Arrow keys, Home and End navigate the tab bar.

The source selector offers **From URL**, **Upload audio**, and **Find song**.
In Find song, enter a title, artist, or description (up to 500 characters), then
select **Search**. Typing and pressing Enter in the query do not start a search
or submit audio. While the search is pending, the form shows
**Finding on YouTube Music…**. The returned
title, artists, and **Verify on YouTube Music** link let you check the match.
Its canonical URL immediately feeds the existing key preview, but a processing
job is created only when you select **Download song** or **Process audio**.
Editing the query, clearing the selection, or switching source modes invalidates
the match and cancels browser polling/key preview, so an old match cannot be
processed for a new query. This does not cancel remote model work already started.
URL, upload, and query drafts remain separate; processing options and mixes stay
in place. Submission retains the selected match and query just like other sources.

Where `SpeechRecognition` or Safari's prefixed `webkitSpeechRecognition` is
available, a microphone button offers user-initiated dictation. It fills the
query only: select **Search** afterward. The button switches to **Stop voice
input** while listening, and permission, network, and no-speech failures leave
typing/retry available. Leaving the source or editing the query aborts dictation;
late callbacks cannot replace newer text. Use HTTPS (or localhost) and grant
microphone permission. Recognition may use the browser vendor's online service;
microphone audio is not uploaded to this app's processing API. Unsupported
browsers simply omit the microphone button.

Pitch and tempo have explicit **− / +** buttons in the mobile **Adjust** tab and
desktop rail, with accessible decrease/increase names and 44px touch targets.
Each tap changes pitch by one semitone or tempo by one percentage point; direct
number entry still accepts fractional values. The pitch field also shows an
inline target-key badge inside its border, computed live from the original key
and pitch shift (including fractional offsets). It is hidden until the key and
pitch are known and valid. Tempo decrement is disabled when the next step would
reach zero or below, without restricting positive fractional manual entry.
Incomplete numeric entries remain editable; their step buttons are disabled
until a number is entered. Key and output previews update immediately.

The mobile summary and primary action stay within the form's sticky boundary,
then scroll away before Results and History, leaving players and downloads
accessible. Editable fields use 16px text; controls and mobile downloads have
44px minimum touch targets. Safe-area insets are respected, and focusing a source
or numeric input releases the sticky action for shorter keyboard viewports.
Advanced contains the cache-bypass option. Download-only remains the default,
and pitch/tempo never modify the original. After submission, the source selection
and all form options remain in place so you can submit the same URL or selected
file again without re-entering them.

All audio players in the workspace share one-at-a-time playback: starting any
source, result, or history audio pauses the other players without resetting their
playback positions. Newly mounted players follow the same rule.
The frontend regression inventory includes CPU-browser checks for URL and upload
form retention across completed repeat submissions.


## Lyrics with pitches

Choose **Lyrics with pitches** to show detected notes above intact lyric words
and download the same layout as UTF-8 TXT or formatted OpenDocument (`.odt`).
The ODT can be uploaded/opened in Google Docs. This is a separate opt-in output: it reuses the
existing Qwen/MMS lyric alignment and CREPE notes, without selecting the plain
lyrics or pitch-timeline checkboxes, introducing another model, or adding audio exports.
The no-options download-only/no-GPU default is unchanged.

The vocal-stem selector covers the same selected vocal-only outputs as pitch
detection, including dry variants. Without a selected vocal output, it analyzes
full vocals internally; that prerequisite is not offered as a vocal download.
The preview counts one pitched TXT for each analyzed stem. Selecting plain
**Extract lyrics** or **Detect vocal pitch** as well still shows those explicitly
requested views.

Pitch rows are above lyric rows in fixed-width whole-word cells. The timestamp
is the left prefix of the **lyric row**, not a separate third row; the pitch row
starts with the same number of display columns in spaces. Unknown `[??:??]`
and timestamps beyond 99 minutes use their actual prefix widths.
A word spanning several detected notes keeps the full ordered sequence,
including distinct repeated notes; cells widen when that sequence is longer
than the word. No syllable boundaries are invented. All three formats wrap
long lines together, **between whole-word cells**, at 78 columns, preserving
each pitch/lyric pair. Continuation pairs retain the same left indent.
An indivisible word/melisma wider than that remains intact: the browser/TXT
can scroll, and ODT uses a wider page rather than shrinking the font.
The browser uses a horizontally scrolling monospace block on small screens.
Accented Latin, Cyrillic, combining marks and East Asian wide/full-width lyric
characters use shared display-column padding. The server also supplies the
unique `wide_characters` for each track; the browser reserves two monospace
columns for those glyphs even when its CJK fallback font has narrower metrics.
The canonical text, spaces and word wrapping are unchanged. This is not a
general emoji/grapheme terminal renderer.

Canonical reference lines, their original order, section headings and untimed
disputed words remain intact. Newly published reference-aligned words carry a
parallel `canonical_word_positions` array identifying their exact reference
line/token and published-word index. This survives the final sort with ASR extras
and links directly to the unchanged pitch-word index order. It does not match
repeated words greedily. Legacy reference records without that provenance stay
explicitly unknown; non-reference ASR uses only unambiguous exact ordered word
matches within its own measured line bounds. `?` means missing/unconfirmed or
ambiguous alignment, or no detected pitch — **not a musical rest**. Full-vocal
word alignment does not independently recognize the lyrics of each split voice.

These pitched exports use **output-clock, start-only timestamps**: `125%` tempo divides
lyric/section onsets by `1.25`. Notes use the output pitch projection, not the song
key or a fresh measurement of transformed audio. Labels are compact `C#4`, etc.,
rounded to the nearest semitone for all shifts, like pitch-timeline rectangles.
Exact requested fractional shifts remain in the download filename; pitch JSON
retains fractional MIDI/frequency/cents. Ordinary lyric TXT/JSON stay on the
original clock. Automatic lyric alignment and monophonic note estimates can be wrong.
Each pitched export starts with the same `Artist — Track` identity line, followed by
`Tonality: <key>` — the detected source key transposed by the requested shift
(fractional shifts append residual cents), omitted when the source key is unknown.

`JobDTO.pitched_lyrics` supplies the canonical per-stem text to both Results and
History. The session-protected download endpoint is
`/api/jobs/{id}/pitched-lyrics/{label}/download`; `format=txt` is the default,
and `?format=odt` selects OpenDocument. Other formats are rejected.
Both formats use the same owner/stem authorization and shared word-cell renderer,
with filenames such as
`Song - lead - lyrics-with-pitches - pitch+1.25st - tempo125pct.txt`
or the same name ending in `.odt`. Existing stored jobs get the new layout and
download formats immediately from their stored transcript/pitch analysis;
no audio processing, model rerun, or algorithm/cache-version change is needed.
Reference-position provenance is a defaulted top-level transcript addition;
existing Word/Pitch JSON shapes and schema-2 decoding remain compatible.

### OpenDocument formatting and import

ODT exports use light-gray pitch text (`#aaaaaa`), black lyrics, and **bold
square-bracketed text**, including timestamps, headings and bracketed lyric
directions (even when those directions continue across wrapped pairs).
Each pitch/lyric pair is one paragraph with an explicit line break and
keep-together pagination; headings keep with the following paragraph.
Spaces are encoded explicitly rather than relying on an importer's whitespace
collapsing. The package is standard ODF 1.2, with its uncompressed MIME entry
first and an XML manifest; no new production dependency is required.

The Western font is 10pt **Courier New**, a
[Google Docs-supported font](https://developers.google.com/apps-script/reference/document/font-family),
declared fixed-pitch/modern for fallback. Full-width CJK uses 12pt Noto Sans Mono
CJK SC to match two 6pt Western columns. LibreOffice was exercised with its
metric-compatible Liberation Mono substitution: synthetic seven-page documents
preserve every pitch/lyric pair, combining/Cyrillic/CJK grid positions, gray ink
and visibly bold brackets. The wide-page long-melisma case is also covered by
the real-render regression. **Signed-in Google Docs import was not tested**;
its CJK font substitution and pagination may differ, so inspect wide-script
alignment after import. No embedded font or guaranteed Google Docs CJK fallback
is claimed.

Focused regressions:

```sh
uv run pytest tests/test_pitched_lyrics.py tests/test_pitched_lyrics_odt.py
# Optional real-render checks require LibreOffice, Courier New (or Liberation
# Mono), Noto Sans Mono CJK SC, and the temporary inspection dependency:
uv run --with pymupdf pytest tests/test_pitched_lyrics_odt.py -k libreoffice
# Existing isolated CPU harness: real browser downloads, no GPU jobs.
npm --prefix frontend run test:e2e -- --visual pitched-lyrics-odt.spec.ts
```


## Vocal pitch detection

**Detect vocal pitch** is opt-in and independent of the global musical-key
estimate or the pitch-shift control. It analyzes every selected vocal-only stem:
full/decrowded vocals, male/female, lead/backing, and their selected dry versions.
Instrument stems and vocal-plus-instrument mixes are never passed to the
monophonic estimator. If no vocal output is selected, full vocals are extracted
internally for analysis without adding an unwanted vocal download.

The estimator is [torchcrepe 0.0.24](https://github.com/maxrmorrison/torchcrepe),
using the **full CREPE neural model**, its official **weighted-argmax decoder**,
16 kHz mono audio, 10 ms frames, and a 50–2006 Hz source-frequency range.
The upstream default Viterbi decoder locked to the upper range edge on a
calibrated C4/A4-plus-silence test; the official local decoder passed that same
known-frequency boundary. Frames below 0.21 model periodicity or −60 dBFS RMS
are omitted. Median smoothing, semitone transition hysteresis and an 80 ms
source-time minimum produce note regions while preserving real rests.
These are automatic monophonic melody estimates, **not an engraved score or
polyphonic transcription**. Bleed, harmonies, noisy recordings, vibrato and
octave errors can produce incorrect or fragmented notes. Confidence is model
periodicity, not a guarantee of musical accuracy.

Both the [torchcrepe implementation/license](https://github.com/maxrmorrison/torchcrepe/blob/master/LICENSE)
and the original [CREPE model repository/license](https://github.com/marl/crepe/blob/master/LICENSE)
are MIT-licensed. torchcrepe's
[weight provenance](https://github.com/maxrmorrison/torchcrepe#readme) explicitly
identifies its bundled full/tiny weights as conversions of those original CREPE
models. No additional pitch-model license restriction was found in those
upstream sources. Pitch inference runs in a subprocess in the isolated
Python 3.12/Torch environment; it does not replace the separator's global ONNX
runtime, load Qwen/SongFormer for pitch-only jobs, or change the no-GPU default.
SongFormer/MuQ and MMS alignment have separate noncommercial restrictions when
lyrics are selected.

Results show time horizontally and chromatic note/octave vertically, with
detected note rectangles labeled `C#4`, `F3`, etc. Selecting a rectangle seeks
the native reference player and shows its estimated frequency, residual cents,
confidence and interval. Click or tap the top time ruler to seek without changing
paused/playing state; horizontal swipes still scroll rather than seek. Ruler
coordinates follow horizontal scroll and zoom, ignore the sticky note axis, and
stop at the analysis duration even where the minimum canvas width leaves blank
space. Focus the ruler for arrow-key one-second steps, Page Up/Down ten-second
steps, and Home/End. The playhead follows the native player. Phones scroll within
the timeline instead of squeezing the song to screen width; buttons and a native
zoom slider provide 40–640 px/s. The initial vertical view centers the typical
vocal register, while every detected high/low row remains reachable by scrolling.

**Background audio** is independent of the detected **Vocal stem** selector.
Choose **Full song** (the transformed song when available, otherwise the
unchanged original) or **Just vocals** (all vocal parts, not necessarily the
selected detected voice). Other exported detected vocal stems can also be chosen
explicitly. The initial reference retains the matching exported stem when one
exists. Switching backgrounds preserves the current output-clock position,
maps it to the new source's clock, and stops the old source without autoplay.
Selecting another history job resets its playback and reference state.
Source-picker rows shrink within mobile cards, so long transformed-stem labels cannot widen the device viewport or displace note tap targets.

New pitch-timeline jobs retain their already-computed full-vocal prerequisite
as a private listening reference even when **Extract vocals** was not selected.
It receives the same pitch/tempo audio transform as public outputs, but is not
added to the download manifest. `JobDTO.has_pitch_vocals` reports actual persisted
availability; the owner-protected
`GET /api/jobs/{id}/pitch-reference/vocals` serves either this private file or an
existing public full-vocal result.

Older pitch-only jobs offer **Recover cached vocals** when their original is
still stored. The owner-protected `POST` on the same reference endpoint reads
the exact source/model/checkpoint/runtime-versioned full-vocal cache in a
Modal function, then applies the existing local audio transform. Cache-only
recovery allocates the same GPU runtime as the producer solely to preserve its
native-library cache identity: CPU and GPU containers can resolve different
FFmpeg dependencies even with the same image and package versions.
It does **not** load or run the separation model. New jobs already retain their
private vocal reference and do not need this legacy recovery call.
It never redownloads the source, loads a neural model, reruns separation,
ASR or pitch detection, or changes public outputs. A missing source or matching
cache is reported explicitly; historical incompatible cache identities are not
guessed. Corrupt/unreadable exact-cache artifacts report a lookup failure rather
than a misleading cache miss. This recovery requires deploying the new
`recover_pitch_vocals` Modal function alongside the web changes.

Note tooltips appear immediately on hover, focus or tap: the compact pitch label
is the first row, with associated lyrics on a second row only when available.
Word-lane tooltips show only the lyrics, also immediately. Native delayed titles
are removed; diagnostic details remain in accessible labels and the selection
panel. Tooltips render outside the scroll clipping area and dismiss on
scroll/resize or Escape instead of leaving stale floating labels.

**Pitch times and pitches use the output clock/key.** Detection runs once on
the original, untransformed stem. A tempo of `125%` divides note and word times
by `1.25`; a shift of `+1.25` adds exactly `1.25` to detected MIDI pitch and
multiplies frequency by `2 ** (1.25 / 12)`. Chromatic labels/cents follow the
resulting fractional pitch. These are **projections of original detections,
not a second measurement of the rendered waveform**. If unchanged-original
audio is the available reference, its original playback clock is mapped to
the output timeline and the UI says so. Original audio bytes and the separate
lyrics transcript's original-clock timestamps are never transformed.

Selecting **Extract lyrics** too adds audio-derived MMS CTC word intervals from
full source vocals, not interpolated segment times. Word intervals below the
notes are visibly labeled **approximate**; selecting a word highlights its
overlapping notes. A word may span several notes (melisma), without inventing
syllable boundaries. Split-voice tracks share that full-vocal word reference;
the UI does not pretend to have independently recognized/aligned every singer.
Reference reconciliation happens before these links are made. Provider-only,
uncorroborated words do not acquire word links, and the complete unprompted
recognition remains in provenance. Empty voiced tracks stay honestly empty.

**Download pitch JSON** is available from Results and History through the
session-protected `/api/jobs/{id}/pitch` endpoint. The same canonical payload
appears as `pitch` in job detail/history/SSE. Version 1 includes model,
source/output durations, requested pitch/tempo, explicit output timestamp/pitch
references, and per-stem `tracks`. Each note has `start_s`, `end_s`, fractional
`midi`, `frequency_hz`, `note`, residual `cents`, `confidence`, and `word_indices`
into the shared timed `words` list. New lyric jobs identify `word_alignment` as
`torchaudio/MMS_FA`, or `null` when word alignment is unavailable. Historical
`whisper-approximate` data remains readable. New clients explicitly request
analysis RPC schema 2; during GPU-first promotion pre-versioned web clients get
readable text without unsupported new word/provenance fields or fake confidence.
The ordinary audio-only `separate` dictionary RPC is unchanged.

## Pitch, tempo, and musical key

- **Pitch shift (semitones):** `0` is unchanged; positive values transpose up,
  negative values down. Fractional semitones are supported.
- **Tempo (% of original):** `100` is unchanged, `120` is 20% faster, and `80`
  is 20% slower. Tempo must be positive. Pitch and tempo are independent.
- With no separation selections, changing pitch or tempo produces a full-song
  `song` output locally. When pitch is nonzero, the full-song output is also
  included alongside any selected transformed stems or mixes. The original is
  always displayed as **Original (unchanged)**, so a pitch-shifted job offers the
  unchanged source, the transformed full song, and each chosen transformed output
  without duplicating the original. Full-song and stem download names follow the
  same canonical naming convention, including the source title, label, detected
  source key when available, and applied pitch/tempo descriptors. Identity
  settings produce no extra output.
- Every final output (including mixes and the full song) is rendered using one
  offline Rubber Band **R3/Finer** pass with both settings together and formant
  preservation. There is no separate pitch-first or tempo-first pass.
  Separation caches remain unmodified; identity settings bypass rendering.
- Derived downloads identify the detected **source key**, when found, before any
  pitch/tempo settings: `Song - vocals - source-key-C-major - pitch+2st - tempo120pct.mp3`.
  Here `C major` remains the source key even though the output is `D major`.
  Without a detected key, the name remains `Song - vocals - pitch+2st - tempo120pct.mp3`,
  with no unknown-key token. The original audio's download name and bytes stay
  unchanged; persisted stem filenames are not renamed, so existing history
  downloads continue to work.
- Results and history show the estimated **original key** and **output key**.
  The original is analyzed once using Mixxx's libkeyfinder; the output key is
  derived from the pitch offset, preserving major/minor mode. Fractional
  offsets include residual cents. Tempo alone does not change the key.
- Every derived stem card in Results and download chip in History also shows
  **Source key: C major** when found, using the job's original analysis rather
  than reanalyzing stems or labeling the transposed output as the source.
  Undetermined keys have no per-stem badge.
- Key detection is an estimate of a global major/minor key, not chord or
  modulation tracking; silence is shown as **Undetermined**. Historical jobs
  without key analysis also show Undetermined. Large pitch/tempo changes can
  introduce audible artifacts.
  Analysis decodes **every frame** into mono 11025 Hz PCM before invoking the
  native estimator; it never limits analysis to an excerpt or changes the original.
  libkeyfinder already averages channels and analyzes a low-passed band below
  2 kHz, so this rate preserves its analyzed frequencies without retaining
  full-rate stereo PCM and copies in memory. Resampler/filter differences can
  affect borderline estimates; this remains a global musical estimate.
- Attaching a file automatically analyzes its key; a valid HTTP(S) URL starts
  analysis after a short debounce. A spinner shows analysis progress before
  submission. The pitch control shows the original and target key with
  diatonically spelled scale notes; minor scales are explicitly **natural
  minor**. Completed Results and History also show the notes. Undetermined keys
  have no fabricated scale.
- Preview analysis uses session-protected `POST /api/key-analysis` with exactly
  one multipart `file` or `url`, returning `{"original_key": "C major"}` (or
  `null` for silence). It runs download/key analysis off the request loop, uses
  temporary files, and creates no job/history entry or GPU call. Download and
  decode failures are visible errors. Replacing the source cancels/ignores stale
  previews. URL preview downloads independently; submitting the final job
  downloads/analyzes it again rather than retaining a preview cache.

Rubber Band is GPL-2.0-or-later (commercial licensing is available), and
libkeyfinder is GPL-3.0-or-later; review these obligations before distributing
a proprietary application containing them.

## Local development

### Prerequisites

- Python 3.15 (the latest stable minor) and [`uv`](https://docs.astral.sh/uv/),
  for the backend and local Modal client. `.python-version` selects this minor;
  `requires-python = ">=3.15,<3.16"` keeps the tested interpreter range explicit
  instead of silently selecting a future minor before its dependencies support it.
  CI and Docker use the same Python 3.15 runtime.
- [Node.js](https://nodejs.org/) 22+ and npm, for the frontend.
- `ffmpeg` and [`deno`](https://deno.com/), for `yt-dlp`'s audio extraction
  when submitting by URL — `ffmpeg` converts the download, while Deno executes
  YouTube's JavaScript challenge solver. The project installs `yt-dlp[default]`
  so `uv.lock` includes the matching `yt-dlp-ejs` solver scripts, rather than
  a JS runtime without its scripts. `uv sync --frozen` installs both; the weekly
  downloader update refreshes them together. FFmpeg and Deno are included in the
  Nix devShell and production image. Correct challenge tooling does **not**
  guarantee YouTube accepts a particular network/IP or remove bot/auth restrictions.
- `rubberband` CLI version 3+ (R3 support) and `keyfinder-cli`, for stem
  transformations and key detection. Both are included in the Nix devShell
  and production Docker image; the image builds a pinned, checksum-verified
  native keyfinder executable.
- A [Modal](https://modal.com) account, for actually running separations —
  run `uv run modal token new` once to authenticate (or set `MODAL_TOKEN_ID` /
  `MODAL_TOKEN_SECRET`). `modal` is a project dependency (installed via
  `make init`), not a global command, so it's always invoked through `uv run`.

### Using Nix

If you have [Nix](https://nixos.org/) with flakes enabled, `flake.nix`
provides a devShell with stable Python 3.15, `uv`, Node.js, `ffmpeg`, `deno`,
`rubberband`, and `keyfinder-cli` pinned (Linux and macOS, x86_64 and arm64).
The nixpkgs pin uses the maintained `nixpkgs-26.05-darwin` branch: it supplies
Python 3.15.0 on all four platforms, while newer unstable nixpkgs has dropped
Intel Mac support. Linux uses the same pin, not a separate runtime fallback.
`ruff` and `ty` come from the dev dependency group, so `make lint` uses `uv run`:

```sh
nix develop
```

### Python runtime compatibility

The Python 3.15 cutover updates the incompatible native dependency graph, not
just the interpreter selection. In particular, locked watchfiles 1.1.1 used
PyO3 0.26, whose safety check rejects Python 3.15. The lock now uses
[watchfiles 1.3.0](https://pypi.org/project/watchfiles/1.3.0/), which supports
Python 3.15 using PyO3 0.29 and its upstream stable-ABI wheels. The relevant
HTTP/event-loop, Pydantic, CBOR, and aiohttp native dependencies also move to
Python 3.15-compatible releases. `uvicorn[standard]` and real watchfiles-based
reload remain enabled; no ABI compatibility override is needed.
[Modal SDK 1.6.2](https://pypi.org/project/modal/1.6.2/) supports the 3.15
client; the formerly locked 1.4.2 explicitly required Python below 3.15.

The **remote Modal GPU image intentionally stays on Python 3.13** with its
existing audio-separator/CUDA stack. As of the cutover, published
[PyTorch](https://pypi.org/project/torch/2.14.1/),
[torchaudio](https://pypi.org/project/torchaudio/2.11.0/), and
[ONNX Runtime GPU](https://pypi.org/project/onnxruntime-gpu/1.31.0/) wheels do not
include CPython 3.15; the configured PyTorch CUDA 12.4 index also has no cp315
wheels. This is a separate dependency environment, not a backend Python pin.
Shared `separator/` source therefore retains Python 3.13-compatible syntax
(the Ruff target), while backend type checking targets 3.15.
The 3.15 client was exercised against an ephemeral CPU-only Modal function on
3.13, including a real `SeparationOptions` dataclass roundtrip; no GPU image or
production deployment was changed.

### First-time setup

```sh
make init                                  # installs backend + frontend deps
make deploy-modal                          # deploys the GPU function to Modal
                                            # re-run after separator graph/options/runtime changes
```

If this repo lives inside a cloud-synced folder (Dropbox, iCloud, etc.),
exclude `.venv` and `frontend/node_modules` from sync — otherwise the sync
client can re-touch or re-materialize compiled `.so`/native binaries after
`make init` installs them, which macOS's code-signing checks then reject
with an `ImportError: ... library load disallowed by system policy`, or
which trips `uvicorn --reload` into an unnecessary restart loop. On macOS
with Dropbox:

```sh
xattr -w com.dropbox.ignored 1 .venv
xattr -w com.dropbox.ignored 1 frontend/node_modules
```

If you hit that `ImportError` before setting this, just recreate the venv:
`rm -rf .venv && uv sync`.

### Run the app

```sh
make dev
```

This starts the backend (`uvicorn --reload` on `:8000`) and the frontend
(Vite dev server, proxying `/api` and `/health` to `:8000`) together in one
terminal, prefixed `[backend]`/`[frontend]`, and stops both on Ctrl-C. Open
the URL Vite prints (typically `http://localhost:5173`). Job data, uploads,
and results are written to `./dev-data/` (gitignored).

### Lint / typecheck

```sh
make lint
```

Run `make test` for backend/domain/native tests (including simulated-boundary
HTTP tests), and `make test-frontend` for jsdom/Vitest tests. Native audio
scenarios require the tools above and are skipped when those executables are
unavailable. These suites are not a substitute for exercising deployed GPU
inference and real browser downloads.

### Real full-stack verification

`make test-e2e` (equivalently `npm --prefix frontend run test:e2e`) builds the
production frontend, serves it from a real uvicorn backend, and drives Chromium
through the UI. It requires Modal credentials and an **explicit isolated**
`E2E_MODAL_APP_NAME`; the harness rejects both production names,
`audio-separator` and `audio-separator-v2`.
It allocates loopback backend/source-server ports and a temporary `DATA_DIR`,
serializes GPU jobs, and removes its servers and temporary state afterward.
It never uses `dev-data/`. Existing processing/audio cases use real native and
Modal boundaries. The explicitly labeled song-discovery UI cases below instead
control search/key responses, keeping external LLM/YouTube availability out of CI.
All browser specs are parsed before the build and backend startup.

With the native tools above, Python/Node dependencies installed, and Modal
credentials configured:

```sh
npm --prefix frontend ci
npx --prefix frontend playwright install --with-deps chromium
export MODAL_ENVIRONMENT=ehpc-audio
export E2E_MODAL_APP_NAME="audio-separator-e2e-$(date +%s)"
trap 'uv run modal app stop --env "$MODAL_ENVIRONMENT" -y "$E2E_MODAL_APP_NAME" || true' EXIT
uv run modal deploy --env "$MODAL_ENVIRONMENT" separator/modal_app.py --name "$E2E_MODAL_APP_NAME"
MODAL_APP_NAME="$E2E_MODAL_APP_NAME" make smoke
make test-e2e
```

On NixOS, use a native Chromium executable through
`E2E_CHROMIUM_EXECUTABLE=/path/to/chromium` and install Playwright's recording
helper with `npx --prefix frontend playwright install ffmpeg`. The direct GPU
smoke also uses the shared voiced fixture, so it requires Node and FFmpeg.

For a self-contained real-model mixer proof without deploying any app:

```sh
MIXER_EVIDENCE_DIR=/tmp/stem-mixer-proof \
  uv run pytest -m smoke tests/test_mixer_smoke.py -s
```

This starts a uniquely named ephemeral Modal app and private ephemeral model
volume, then a real local HTTP server and queue. It processes the licensed voiced
fixture through all four requested pairs, a three-component mix, and all four
vocal-variant/instrument mixes. Downloaded audio, Title tags, timing, stereo/48 kHz,
peak levels, hidden prerequisites and unchanged original bytes are checked.
The cleanup case additionally compares mixes against independently exported real
cleaned/dry component audio. App, volume and local server are released on exit;
MP3s and `proof.json` remain in the evidence directory. Deterministic local tests
separately measure per-component spectral amplitudes, non-normalized sums,
multichannel alignment, overload limiting, unsafe/duplicate names, privacy,
interrupted-job recovery, retry and historical migrations.

The default browser matrix contains **66 cases**, covering processing/behavior,
unknown keys, download metadata, native MP3 uploads, responsive workspaces,
adjustments, retained forms, lyrics, exclusive playback, vocal pitch, pitched
lyrics, and six song-discovery UI cases. The separate visual and manual YouTube
suites are excluded from this matrix.

The six discovery cases exercise five viewport widths (375/390/430/1440/2560),
explicit search, pending/selected states, canonical URL key-preview handoff,
stale-source protection, 16px inputs, 44px buttons, and no automatic job creation.
The sixth simulates the prefixed Web Speech API for deterministic dictation and
permission/lifecycle coverage; it does **not** prove a physical microphone or
actual Safari. Vitest additionally covers polling cancellation, provider errors,
Unicode normalization, race ordering, clear selection, retry, retained mixes,
unsupported browsers, and stale speech callbacks. Run these browser cases with
`npm --prefix frontend run test:e2e -- --cpu song-discovery.spec.ts`.
These controlled API fixtures prove the UI contract, not real LLM/catalog accuracy.

The form-retention cases use real native processing without GPU calls: desktop
URL and mobile file upload each complete two submissions without refilling or
reselecting the source. They check native FileList/URL, every option, fractional
pitch/tempo, key/output previews and selected workspace tab after both POST and
completion, alongside persisted job options and unchanged original-download
hashes. Run only these cases with
`npm --prefix frontend run test:e2e -- --cpu form-retention.spec.ts`.

The lyrics case runs two real jobs against checksum-verified public-domain JFK
speech: lyrics-only, then lyrics with a selected vocal stem and pitch/tempo
changes. It checks the known spoken phrases, original-clock timestamps,
Results/History rendering, canonical TXT download bytes, unchanged source audio,
and mobile readability. It attaches actual desktop/mobile transcript screenshots
as test artifacts, not nondeterministic live-ASR screenshot baselines.

The pitch cases process the uncut, checksum-verified 141.5-second public-domain
*Auld Lang Syne* fixture through actual separation, CREPE, Qwen/MMS and native
audio rendering, plus a pitch-only sung excerpt with a hidden vocal prerequisite.
They verify selected per-stem note/word consumers, known sung phrases, real
word-to-many-note links, fractional pitch/tempo clocks, native seek/playhead and
exclusive playback, JSON/original downloads, History, and session isolation.
Desktop and 390px touch-context screenshots include the shortest associated
note at maximum zoom, checking that its full 12px note label fits its true
time-width rectangle without making the page horizontally overflow.

The pitched-lyrics cases use that same complete public-domain recording and
unchanged sung excerpt with the new option alone or selected vocal outputs.
They verify real per-stem note sequences/melisma, output-clock lyric onsets,
browser/TXT byte identity for every stem, canonical word preservation, meaningful
transformed download names, History, mobile horizontal scrolling, exclusive audio
playback, session isolation and the absence of implicit legacy views/audio exports.

The singing source is [Frank C. Stanley's 1910 *Auld Lang Syne* recording](https://commons.wikimedia.org/wiki/File:Auld_Lang_Syne.ogg)
(Indestructible #1267 / UCSB Cylinder4410), marked public domain by Commons.
The uncut source is `tests/fixtures/auld-lang-syne-full.ogg`, SHA-256
`0d277de969ce02959923ec32fd94897a6791cf183fd954198d5e02166e36fb04`.
The 30-second FLAC excerpt is source12–42s, decoded/resampled to mono16kHz;
neither source fixture is pitch/tempo modified. The visual JSON retains actual
CREPE/Whisper detections/recognition from that recording, not hosted reference lyrics.


The seven adjustment cases cover 375/390/430px touch and 1440/1920/2560/3840px
desktop; they exercise real taps/clicks, keyboard activation, fractional manual
entry, positive-tempo bounds, tab persistence, reactive key/output previews, 44px
button geometry, and horizontal overflow against the real backend's key analysis.
They run without GPU work using
`E2E_MODAL_APP_NAME=audio-adjustment-ui-check E2E_CHROMIUM_EXECUTABLE=/path/to/chromium npm --prefix frontend run test:e2e -- adjustments.spec.ts`.
Chromium mobile emulation does not verify Safari's rendering or the iPhone keyboard.

The responsive cases iterate every grouped processing control rather than pinning
the number of controls. They check visibility and unobstructed hit targets,
mobile state persistence, and the actual all-selected output preview (including
the lead/instrument mix). They run without GPU work using
`npm --prefix frontend run test:e2e -- --cpu responsive.spec.ts`.

The metadata case uploads the deterministic local tonal fixture through the UI,
waits for native key analysis, and applies fractional pitch and tempo changes to
the full song with no extraction/GPU work. It downloads the actual generated MP3
from Results and, after reloading, History; FFprobe checks that the embedded
Title equals Chromium's suggested filename without `.mp3`, including the source
name, stem, source key, pitch, and tempo. Both generated downloads must be
byte-identical, and both original downloads must preserve the uploaded bytes.
Chromium/FFmpeg decoding also checks the transformed duration and pitch. Run this
case without Modal credentials or network audio fixtures:

```sh
npm --prefix frontend run test:e2e -- --cpu metadata.spec.ts
```

`--cpu` reuses the real production frontend/backend harness and native audio
tools with deterministic local fixtures and a nonproduction Modal app name;
select only CPU-compatible specs, since it does not replace GPU processing.
The case saves `metadata-proof.json`, raw FFprobe JSON, Results/History
screenshots, and actual downloaded files alongside the normal browser artifacts.

The MP3 upload matrix uses FFmpeg-encoded stereo MP3 bytes with `audio/mpeg`,
generic `application/octet-stream`, and empty browser MIME types at desktop and
390px widths. It exercises native key preview, multipart submission, completed
download-only jobs, and byte-identical original downloads in Results and reloaded
History. MPEG/generic cases use Chromium's file chooser; the empty-MIME case uses
a browser `File`/`DataTransfer` change because Playwright otherwise infers MPEG.
The picker retains `audio/*` and adds extension hints for MP3, WAV, FLAC, M4A,
OGG, AAC, Opus, and WebM so a provider's missing audio MIME is not the only hint.
These hints do not validate or relabel file contents. Physical mobile/cloud
provider pickers and Safari are not covered. Run without GPU calls:

```sh
npm --prefix frontend run test:e2e -- --cpu mp3-upload.spec.ts
```

Each case records `mp3-upload-proof.json`, selected-file MIME, actual request
`multipart/form-data` headers, native codec/key results, original-byte hashes,
and selection/Results/History PNGs under `frontend/test-results/`.

- Independent output/cleanup/split selections and arbitrary mix-only cases prove
  that internal prerequisites do not appear as extra downloads. Mix-only cases
  include all four requested pairs, three components, and vocal variants.
  Reference jobs supply component tracks for audio-sum comparisons without
  exposing them in the mix-only job's manifest.
- Mixes with dry vocal prerequisites, both crowd-cleanup selections plus dry
  mixes, and instruments-only plus dereverb exercise dependency-sensitive paths.
- Identity, positive/negative fractional pitch, pitch-only, tempo-only,
  speedup/slowdown, and transformed separated output exercise native processing.
  Combined-options transformations check modified names/durations across selected
  stems and named mixes while preserving the unchanged original. Identity cases
  retain the raw mix-composition proof. Whole-song changes prove expected audio
  duration and the known generated fundamental's pitch shift; originals are
  downloaded and hash-checked.
- Repeated extraction and custom-name changes retain valid private job outputs.
  Browser output hashes alone do not prove inference was skipped: cache tests
  observe actual producer calls and forbid a second call on a valid hit.
- File and real HTTP URL inputs exercise key preview and yt-dlp downloads;
  spinner/progress, target keys/notes, stale-key clearing, invalid audio/source
  errors, retry after source recovery, reload/history, and session isolation are
  covered through browser interactions. The dedicated sustained C/E/G triad
  checks known-key accuracy (`C major`) independently of the complex voiced
  song. Both qualified fixtures assert `C major`, and their actual native preview
  must also agree with the UI, persisted original key, and mathematical target
  key/notes after transposition.
- Every detected-key stem checks its visible source label and canonical download
  name, including pitch-shifted outputs whose target key differs. Actual HTTP
  download headers are checked explicitly. A silent fixture exercises real native
  undetermined-key analysis, omission of stem labels/name tokens, unchanged
  original bytes/name, and an eight-second all-zero decoded transformed output.
  Responsive coverage renders the actual built app at desktop widths 1440,
  1920, 2560 and 3840, plus mobile 375×812, 390×844 and 430×932. It checks
  readable text, every desktop group and the right rail, mobile tab/keyboard
  navigation, option and pitch/tempo persistence, real source/key preview and
  errors, Advanced/action clearance, shortened keyboard viewports, and
  unobstructed Results/History downloads and audio playback. The all-enabled
  processing case additionally captures all 21 selected outputs at all seven widths
  and checks that source-key chips and download names stay within the viewport;
  its pitched full-song output is shown in the output preview. A native-scale
  pitched-song card crop shows the source label and download name. All cases use
  the real backend and native audio tools, with no mocked boundaries.

The hosted stereo `C major` → `G major` failure was **not musical ambiguity**:
the upstream keyfinder-cli compatibility path for FFmpeg 6 and older supplied
the channel-layout **bitmask** (`3` for stereo) where libkeyfinder requires a
channel **count** (`2`). That misinterprets sample timing by 3/2 and shifts C to G.
The native regression checks known C-major audio in both mono/stereo and
WAV/MP3, so an octave-equivalent mono result cannot conceal this decoder bug.
The shared native build applies the exact decoder channel-count correction
after verifying the upstream source checksum, for both CI and the Docker image.

Every successful audio-options matrix case downloads its exact audio manifest,
checks public filenames/modification suffixes and absent hidden outputs, decodes
every audio track in Chromium and FFmpeg, and measures channels, timing, finite
samples, signal, and peak levels.
The all-enabled case additionally compares each mix's PCM against the aligned
unity-gain sum of its actual downloaded components. This checks real mixing,
not just nonempty files.

Artifacts are under `frontend/test-results/`: per-case `proof.json` with options,
manifest, queue/Modal evidence, hashes and audio measurements; downloaded audio;
completion screenshots; and `backend.log`/`summary.json`. Failures retain
screenshots, video, and Playwright traces. The HTML report is in
`frontend/playwright-report/`. There are no automatic test retries. CI additionally
emits GitHub annotations for failed assertions and stops on the first failure.
The full-stack gate must complete without skipped cases.

Local domain tests exhaust independent audio-output boolean combinations and
exercise arbitrary mix selections with decoded waveform/spectral assertions.
These are deterministic local checks, not thousands of GPU runs or a proof over
arbitrary numeric pitch/tempo values.

CI runs native/backend/frontend checks, real GPU smoke tests, the browser matrix
against a unique test app, and the visual suite below for every push/PR. Only a
passing main run promotes `audio-separator-v2` and publishes the image. The old
`audio-separator` app remains untouched for old web instances. Both promotion
jobs retain the deterministic/native, full-stack and visual release gates.
The separate manual YouTube workflow is not a release dependency.

### Real external YouTube key analysis

`npm --prefix frontend run test:youtube` builds the real frontend/backend and
runs one isolated CPU-only browser case using exactly
`https://music.youtube.com/watch?v=wf5RdLDxrUk&si=ANzOjMlDcHwwlwOL`.
It requires the native tools, yt-dlp, Deno, Chromium, and external YouTube/media
network access, but **no Modal deployment or credentials**. It enters the URL
through the UI, waits for the real download and full-song native analysis,
asserts a standard major/minor key, and checks visible Original/Target key and
the inline pitch badge at pitch zero. It does not hard-code the recording's
musical key, mock network/media/analysis, submit a job, or invoke a GPU.

The separate **Real YouTube key analysis** workflow
(`.github/workflows/youtube.yml`) runs only through `workflow_dispatch`, selected
from GitHub Actions' **Run workflow** control. It preserves this real external
check without making YouTube's runner/IP authentication decisions a push/PR or
release prerequisite. Together with the functional and visual suites it covers
**92 browser cases**, including the explicitly controlled discovery UI cases.
YouTube bot/authentication restrictions, missing tools, and network failures
still **fail the manual workflow visibly**; it never skips or substitutes
fixtures, submits a processing job, or invokes a GPU. Artifacts are uploaded
with `always()`: `frontend/test-results/youtube/` response JSON, UI screenshot,
backend log and Playwright failure artifacts, plus
`frontend/playwright-report/youtube/`. The runtime preflight still checks the
installed dependency environment, Deno, and EJS package version.
To exercise an already released server instead of starting a local one:

```sh
(cd frontend && E2E_BASE_URL=https://audio.ehpc.io npx playwright test --config=playwright.youtube.config.ts)
```

The production 502 investigation found a container `OOMKilled` at its 512 MiB
limit. For this full 356.67-second recording, direct full-rate native input
peaked at 731564 KiB RSS; mono 11025 Hz native input peaked at 96472 KiB and
returned the same estimate. A local real-browser URL run with the entire
backend/downloader/native process tree constrained to 512 MiB (swap disabled)
passed at 205651968 bytes peak. These are measured local runtime results, not
a claim that a particular production release or arbitrary-length track was
verified. The native regression also analyzes a full six-minute stereo recording
with a silent first minute and checks both the later chord's key and peak RSS.

### Deterministic screenshot regression tests

Run `npm --prefix frontend run test:visual` with Docker available. The wrapper
builds and runs `frontend/e2e/Dockerfile.visual`, based on the official
`mcr.microsoft.com/playwright:v1.64.1-noble` image (also pinned by digest) matching the npm lockfile.
Local generation and CI comparisons use that same Linux/amd64 Ubuntu userspace,
Chromium, and bundled fonts, including on NixOS. Do **not** generate baselines
using a host Chromium or override `E2E_CHROMIUM_EXECUTABLE` for this suite.
Updating Playwright requires updating the Docker image version/digest and reviewing
all regenerated baselines together.

The **25 screenshot cases** compare committed PNGs in
`frontend/e2e/visual-snapshots/`: three 390px mobile Outputs/Adjust/Review
screens, two 1440px/2560px desktop workspaces, eight tightly cropped focused
pitch/tempo controls (390px and 1440px, each with zero/C major, +2/D major,
undetermined key, and long fractional cents), two detected-vocal timelines
with linked sung words (390px/1440px), two reference-aligned provenance
views with inline uncertainty and raw recognition (390px/1440px), two
synthetic pitched-lyrics typography views covering Unicode word cells,
repeated-note melisma and explicitly untimed lines (390px/1440px), two mix
builder/review cases, and four song-discovery pending/selected cases
(390px/1440px). These complement, not replace, the **66 functional cases**.
Two additional desktop/mobile geometry cases exercise long transformed-source choices and short notes beside the sticky ruler/word lanes at maximum zoom, using a small purpose-built fixture without inference.
The optional external YouTube case is not a release gate.
There is no redundant full-page viewport/state cross-product.

The suite builds the production frontend and reuses the real isolated HTTP
backend harness. Workspace cases upload synthesized C/E/G audio or silence and
assert real native keyfinder analysis. Timeline cases use committed genuine
CREPE/Whisper output filtered to output9.5–15.2s of the public-domain full-song
fixture (`frontend/e2e/fixtures/pitch-visual-window.json`), preserving its original
clock and notes rather than synthesizing results. They upload the unchanged
source, run the real native full-song transform/storage/API consumers, and
publish the captured inference with queue workers disabled. Only the four
song-discovery UI cases intercept search/key API responses with deterministic
catalog fixtures. No external recording is fetched or Modal function called by
visual tests; existing audio/key cases continue to use real native consumers.
Each case uses a fresh browser context and pinned viewport, scale, clock, locale,
timezone, colors, fonts and CPU rasterization; native audio metadata is loaded
before timeline capture. Animations are disabled and the caret hidden.
Comparisons allow **zero differing pixels** above a strict **0.005 YIQ color
threshold** (only about one RGB level of native-control raster rounding);
there is no pixel-count or percentage allowance for layout changes. A missing
baseline or changed screenshot fails normal runs; they never auto-accept.

For an intentional UI change, explicitly regenerate inside the pinned runtime:

```sh
npm --prefix frontend run test:visual -- --update-snapshots=all
# Review every changed PNG, then run the normal comparison before committing:
npm --prefix frontend run test:visual
```

Pass Playwright filters through the same command, for example
`npm --prefix frontend run test:visual -- --grep "focused pitch"`.
Successful and failed runs retain actual PNGs, native `analysis.json`,
browser/OS/viewport `runtime.json`, backend logs and a Playwright `summary.json`
under `frontend/test-results/visual/`; the report is
`frontend/playwright-report/visual/`. Failures additionally retain expected,
actual and diff images and traces. CI uploads visual evidence on success and
failure. The dedicated CPU-only Docker job is independent of the existing
GPU/full-stack job; production Modal promotion and GHCR publication wait for
both.

### Browser-test fixture licenses

The full-stack browser harness generates its own C-major chord/bass/percussion
track and mixes in two **CC BY 4.0** LibriSpeech excerpts. It fetches the small
recordings from the pinned
[`librosa/data` revision](https://github.com/librosa/data/tree/38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0/audio)
and checks their SHA-256 hashes before decoding them:

| Recording | Attribution | SHA-256 |
|---|---|---|
| [`5703-47212-0000.ogg`](https://raw.githubusercontent.com/librosa/data/38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0/audio/5703-47212-0000.ogg), *The Ashiel Mystery: A Detective Story*, chapter XVI | Marion Bryce (author), Garth Comira (reader) | `a284612b46af0535f7e1873758c4387bb8369f6dbbe192ffdec1f171108f98dd` |
| [`198-209-0000.ogg`](https://raw.githubusercontent.com/librosa/data/38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0/audio/198-209-0000.ogg), *Sense and Sensibility*, chapter 18 | Jane Austen (author), Heather Barnett (reader) | `0473ba9613befa1026db5e254546f105aeffba8366b5468fc5e8d474d844ca1d` |

Source corpus: [LibriSpeech SLR12](https://www.openslr.org/12/).
License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
Modifications: decode/resample, trim to eight seconds, normalize, pan, delay,
adjust gain, and mix with the generated musical track. These changes are test
fixture preparation, not an endorsement by the readers. The generated backing
uses a run-unique percussion seed (recorded in proof JSON) so concurrent test
deployments do not race on the same stem-cache directory. Within one run the
input stays byte-identical for authentic cache-hit/bypass checks. Numeric
pitch/tempo cases use a separate, entirely generated sustained C-major triad
with a dominant known C4 fundamental. It never reaches Modal, so it does not
need a run-unique GPU-cache key. No user
recordings are included or fetched.


### Backend configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `/data` | Root for the sqlite DB, uploads, and results |
| `QUEUE_CONCURRENCY` | `1` | Max separations running on Modal at once |
| `MODAL_ENVIRONMENT` | `ehpc-audio` | Explicit environment for every backend RPC lookup; a nonblank value overrides the default, while missing/blank/whitespace values use the default, never an ambient profile's `main` |
| `MODAL_APP_NAME` | `audio-separator-v2` | Deployed Modal app name to look up |
| `MODAL_FUNCTION_NAME` | `separate` | Deployed Modal function name to look up |
| `COOKIE_SECRET` | *(insecure dev default)* | Signs the session cookie — **must** be set to a stable secret in prod; rotating it logs everyone out |
| `COOKIE_SECURE` | `false` | Set `true` in prod (behind TLS) — a `Secure` cookie is silently dropped over plain HTTP, which is why local dev defaults to `false` |

## Running on Kubernetes

1. **Build and push the image:**

   ```sh
   docker build -t ghcr.io/ehpc/ehpc.io-audio:prod .
   docker push ghcr.io/ehpc/ehpc.io-audio:prod
   ```

2. **Deploy the updated Modal app before releasing matching backend/UI
   changes** from a machine with Modal credentials:

   ```sh
   make deploy-modal
   ```

   CI promotion and `make deploy-modal` deploy **`audio-separator-v2`** into
   **`ehpc-audio`**. The backend passes its configured environment explicitly
   on every named function lookup, independently of the active Modal profile.
   `MODAL_ENVIRONMENT` also scopes CLI commands and isolated SDK smoke tests;
   the browser harness inherits it without a second default. App resource
   declarations resolve volumes and `audio-openrouter` in the deployment's
   environment. An explicit environment override must contain the corresponding
   app, volumes and secret; there is no fallback to `main`.

   For the namespace-only move from `main`, first preserve/copy both
   `audio-separator-models` and `audio-song-discovery` into `ehpc-audio` and
   verify the transferred files before promoting workers or web clients.
   Also preserve/copy `lyrics-structure-noncommercial-models` before target CI:
   this is a **test-only CI model cache**, not another production feature
   deployment, and retaining it avoids downloading its roughly 12.7 GB again.
   Retain the source volumes as well; the protected legacy app shares the
   source model cache.
   Keep volume names, mount paths, model/artifact bytes and producer keys
   unchanged: an environment move is not an algorithm change and must not
   silently replace validated caches with empty volumes. Verify target health
   and cache reuse before switching the web image. Preserve its `/data`
   database/uploads/results and stable session secret; no database migration,
   job/options rewrite or cache-version bump is required for this move.
   Keep **`main/audio-separator-v2`** operational until existing jobs drain
   and migrated web clients are verified; only then retire that old instance.
   The unrelated legacy **`main/audio-separator`** app is protected and is
   never part of this migration. Options remain schema 3 and lyrics/pitch
   transport remains independently schema 2.

   Redeploy the matching v2 worker after changes to `separator/stems.py`,
   `separator/options.py`, or the Modal image. The GPU runtime uses Python 3.13,
   CUDA 12.6.3/cuDNN on Ubuntu 24.04, FFmpeg 6+, `audio-separator[gpu]==0.44.1`
   and `librosa==0.11.0`. New audio RPC calls supply `options_schema=3`;
   incompatible versions fail explicitly. Use the ephemeral mixer smoke above
   for verification without overwriting either production deployment.

3. **Provision cluster resources:**
   - A `PersistentVolumeClaim` (ReadWriteOnce) mounted at `/data` — holds the
     sqlite DB, uploads, and results.
   - A `Secret` with `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`.
   - A `Secret` with `COOKIE_SECRET` — generate once, keep stable across
     redeploys.

4. **Deployment**, `replicas: 1` (see [Architecture](#architecture)):

   ```yaml
   spec:
     replicas: 1
     template:
       spec:
         containers:
           - name: audio
             image: ghcr.io/ehpc/ehpc.io-audio:prod
             ports:
               - containerPort: 8000
             env:
               - name: DATA_DIR
                 value: /data
               - name: QUEUE_CONCURRENCY
                 value: "1"
               - name: COOKIE_SECURE
                 value: "true"
               - name: MODAL_TOKEN_ID
                 valueFrom: { secretKeyRef: { name: audio-modal-token, key: token-id } }
               - name: MODAL_TOKEN_SECRET
                 valueFrom: { secretKeyRef: { name: audio-modal-token, key: token-secret } }
               - name: COOKIE_SECRET
                 valueFrom: { secretKeyRef: { name: audio-cookie-secret, key: secret } }
             volumeMounts:
               - { name: data, mountPath: /data }
             livenessProbe:
               httpGet: { path: /health, port: 8000 }
             readinessProbe:
               httpGet: { path: /health, port: 8000 }
         volumes:
           - name: data
             persistentVolumeClaim: { claimName: audio-data-pvc }
   ```

### Gateway upload size

The approved `audio.ehpc.io` gateway policy is **64 MiB for the entire request
body**, including multipart overhead, configured as `client_max_body_size 64m;`
in both audio virtual hosts. The external Nginx configuration is maintained
outside this repository; keep the override scoped to the audio host rather than
changing limits for unrelated services.

The initial gateway configuration inspected on 2026-10-27 had no override and
inherited Nginx's
[`1m` default](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).
Requests above that former **1 MiB** limit received HTTP **413 before reaching
the backend**, affecting both `POST /api/key-analysis` and `POST /api/jobs`.
This was a deployment request-size restriction, not an MP3 codec or application
MIME restriction; changing the picker or backend alone cannot remove it.

## Known limitations

- No login/auth beyond the anonymous per-browser cookie — anyone with the URL
  can submit jobs. Job history and downloads are scoped to that signed cookie.
- No automatic cleanup of old uploads/results — `/data` grows unbounded.
- Single-pod only, as noted above.

## Reference-first lyrics and audio alignment

### Identity, availability and rights

Lyrics extraction resolves a reference **before recognition**, using the public
[LRCLIB metadata API](https://lrclib.net/docs). Identity comes only from actual
artist/title tags on uploads, or yt-dlp's structured artist/track/album/duration
fields for URLs. Filenames, uploader names and inferred video titles are not
credible identity. Full normalized artist/title, album when available, and a
duration difference of at most two seconds must match. Version qualifiers are
never stripped to substitute an album recording for a live/remixed recording.
Metadata matching is necessary, not proof that every published word is sung.

The client makes one bounded request with an identifying User-Agent, no API key,
scraping, lyrics-prompted LLM, or immediate retry of HTTP errors/throttling.
Successful public records, including their original line-synced LRC, are cached
with provider identity and fetch time. The cache normalizes metadata and encoder
duration precision, then revalidates the complete record on every read; it is not
a title-only cache. It contains reference records, not source audio or user ASR.
Unavailable, invalid, mismatched or absent references leave an explicit reason
and use Qwen's independent recognition rather than the retired sparse-ASR path.

LRCLIB's [server code is MIT-licensed](https://github.com/tranxuanthang/lrclib);
that does **not** grant blanket redistribution rights to hosted lyrics. Lyrics
remain subject to their own rights. Permanent reference tests use synthetic or
public-domain words, not copyrighted Muse audio/lyric fixtures.

### Independent recognition, then actual acoustic alignment

The isolated Python 3.12 environment uses `qwen-asr==0.0.6` /
`transformers==4.57.6`, with Torch/TorchAudio 2.8. It is separate from the
separator's global ONNX GPU and SongFormer's pinned Torch/Transformers trees.
[Qwen3-ASR code and weights](https://github.com/QwenLM/Qwen3-ASR) are Apache-2.0;
the model explicitly supports singing and songs with background music, but
does not guarantee lyric accuracy. Recognition covers the complete original
vocal clock in unprompted 25-second contexts, without speech VAD or song/lyric
text in the recognition prompt.

[MMS_FA](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html)
provides multilingual CTC frame emissions and forced alignment.
Its weights are **CC-BY-NC-4.0**, requiring separate rights for commercial use.
The personal noncommercial authorization described above applies; it does not
grant additional model rights. MMS was trained/evaluated for speech, not a
universal singing-accuracy guarantee. TorchAudio is pinned before removal of
its forced-alignment API. Qwen's timestamp-only forced aligner is not used:
actual singing evaluation produced collapsed zero-duration words.

Reference text is matched monotonically to raw independent recognition, keeping
repeated occurrences distinct. Acoustic inputs for reference phrases retain
20–30-second context rather than tiny speech-VAD/line crops. With plain lyrics
alone, recognition anchors locate candidate phrases. With LRC, ordered text and
bounds must match the canonical lines, and multiple distributed independent
audio anchors must support the provider's clock before it supplies search
priors. Empty LRC rows delimit gaps; they never become lyrics.

**Provider line onsets are candidate search bounds, not measured word times.**
The full-context acoustic model produces phone-frame positions inside a
constrained alignment search. Actual frame positions determine word intervals;
the worker does not copy provider onsets, evenly divide a line into words, or
repair invalid spans into invented timestamps. Both candidate and independently
recognized variants are compared on the same acoustic frames. CTC log likelihood
is normalized by source frames, not target word/character length; scoring
counterfactuals do not reward the recognizer for omitting canonical words.
Contradictory verses/chorus variants require positive acoustic evidence, not a
global text-agreement percentage. The complete canonical reference remains the
primary view in its original order: accepted lines have measured onsets, while
disputed lines render the inline `[??:??]` untimed token. Recording-derived
variants remain separately available in comparison/original provenance, not
silently substituted into the primary reference text.

`probability` is `null` when Qwen supplies no word confidence. `alignment_score`
is observed CTC emission evidence, **not a calibrated probability of lyric
correctness**. Phrase acceptance does not establish every word: per-line
`unconfirmed_words` stay visible and do not receive published word timestamps or
pitch-note links. Unsupported scripts/units and failed alignment retain their
recognized text as untimed rather than claiming a decoding-window start as an
onset. Automatic recognition, metadata and forced alignment cannot establish
100% accuracy for arbitrary recordings.

### One canonical result and original provenance

Results, History, SSE, TXT, JSON and pitch-word links consume the same saved
transcript. SongFormer still analyzes the unchanged original mix for musical
sections. Its estimated `[Verse]`, `[Chorus]` and other headings remain inline
where actual aligned reference anchors locate them, with blank lines between
sections. Genuinely unanchored/ambiguous groups get an unknown-section marker or
a separate beginning-only estimated timeline, not an invented lyric onset.
Ordinary lyrics remain on the source clock. The optional **Lyrics with pitches**
TXT/ODT exports project displayed start timestamps onto the output clock, alongside
pitch output and supported word links. Original audio bytes are never retagged
or transformed.

The canonical JSON includes model/alignment identity, provider source/fetch
time/cache status, ordered reference-line outcomes, local lexical agreement,
acoustic comparisons, and clearly separated provider priors versus measured
intervals. `recognition_chunks` preserve the complete raw unprompted text,
language and input/ownership window bounds, even when alignment drops a word.
Those bounds are not lyric timestamps. Original segments, words and untimed
recognition remain under reference provenance; archived low-evidence fragments
are not interleaved with canonical primary lyrics. Genuine ASR-only candidate
extras outside reference comparison regions are explicitly separate in
`asr_extras` and TXT; their word origin is `asr-extra`. Supported canonical words
are `reference-aligned`. Disputed ASR substitutions do not become canonical
word/pitch links. The former appended uncertainty block no longer exists: word-level
uncertainty stays in the JSON provenance, and the primary reference text includes
every line exactly once.

The browser exposes ordered canonical support, explicit unconfirmed text and
word uncertainty, raw input-window recognition, and original ASR. TXT opens with
the `Artist — Track` identity and marks undetectable onsets with the `[??:??]`
token; `?` inside pitch cells means unknown alignment or no detected pitch.
`/api/jobs/{id}/lyrics/download.json` retains full provenance, while the canonical
TXT is `/api/jobs/{id}/lyrics/download`; both are session-protected, as are
History and pitch downloads. The metadata sidecar stays outside original-audio
folders and cannot become an original download.

The previous one-character spelling policy and global 90% gate are retired.
Historical stored `compared`/`corrected` records and their individual original
correction evidence remain readable without rewriting database rows. Wire
compatibility is a single analysis-schema boundary, not an alternate lyric
algorithm: schema 2 carries canonical nullable confidence/provenance; old callers
during GPU-first promotion receive truthful readable text with unsupported word
links omitted.

Stored records without an explicit recognizer/alignment identity keep that
identity unknown (`null`), including results persisted by an older web worker
during GPU-first promotion. Neither historical probabilities nor word intervals
identify a speech model. Read-only decoding preserves those values and readable
text without guessing Whisper; the browser labels unspecified provenance.


### Measured evaluation and test contracts

An actual full-pipeline staging run of the approximately 227-second Muse
“Hysteria”/“Absolution” recording matched LRCLIB record 66510 and its validated
line-synced candidate. The primary browser/TXT/JSON retained all 30 ordered
canonical lines (118 normalized words). That observed run accepted 29 phrase
alignments (113 canonical words), left one five-word disputed line explicitly
untimed, and published 91 supported word intervals. It recovered 25 word
intervals overlapping 55–80 seconds, where the archived recognizer result had
none, and published no words in the 140–165-second instrumental interval.
Native browser TXT and JSON downloads matched the stored transcript, including
the complete original recognition and the inline disputed line.

These are coverage and provenance observations, **not measured lyric accuracy**.
Copying the candidate reference into the primary view cannot establish an
acoustic word-error rate. Word intervals are acoustic estimates, not manually
annotated boundaries, and a different inference can retain different uncertainty.
No copyrighted recording or lyric body is committed as a test fixture.

The real GPU reference regression uses the public-domain recording and caption
fixture to exercise positive alignment, a contradictory verse/chorus variant,
an actually muted first verse, and the later repeated occurrence. Full-song
pitch/structure tests retain independently known phrase/onset anchors, native
word-to-many-note overlap, source and late-vocal coverage, estimated Verse/Chorus
sections, and the 420.02-second short-tail termination regression. They do not
pin incidental Scots title orthography to one speech model's spelling.
Unreferenced recognition remains fallible; no song-specific spelling replacement
or homophone alias is applied.

