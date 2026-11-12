# ehpc's Vocal Tools

A web app for downloading a song, transforming its pitch/tempo, extracting
selected vocal and instrument tracks or timestamped lyrics, and detecting
vocal melody notes. Submit a URL or upload a file: by default, only the original
song is kept, with **no GPU separation or pitch/lyrics inference**. Explicitly
choose the audio outputs, lyrics, or vocal pitch analysis you want.
Multiple people can use it at once; submissions go through a queue, and each
visitor sees their live position.

## Private access

Invite-only email-OTP access is deployed. The existing send-only mail service
has delivered an approved message that passed SPF, DKIM and DMARC; this does
not establish ongoing deliverability. See [ACCESS_PLAN.md](ACCESS_PLAN.md) for
bootstrap, invitation accounting, credential provisioning and legacy ownership
details.

## Architecture

```text
Browser → FastAPI / SQLite / single audio worker on the VPS
             ├─ downloads, key preview, source-clock DAG and cache lookup
             ├─ reference HTTP, transcript/section/note assembly, mixes and exports
             ├─ independent local song-discovery worker → OpenRouter / YouTube Music
             └─ only a missing model stage → audio-inference-v3 / infer
                                              one bounded GPU pool
```

- **`separator/`** contains the source-clock pipeline and CPU domain logic.
  `modal_app.py` exposes one private `infer` RPC in the `ehpc-audio` environment.
  Its five operations are one separator pass, Qwen recognition, MMS acoustic
  alignment, CREPE frame prediction and full-context SongFormer prediction.
  Native decoding, model-specific preprocessing and codecs stay with a model
  when needed to preserve its exact producer context; standalone planning,
  reference lookups and final assembly do not occupy the GPU.
- **`backend/`** owns the DAG and checks persistent artifacts **before** allocating
  GPU work. Downloads/key analysis, mixing, Rubber Band R3 pitch/tempo rendering,
  tagging and exports run locally. Download-only and whole-song pitch/tempo jobs
  need neither Modal credentials nor a model manifest. SQLite persists queue
  ownership and active finite calls; the existing data volume holds computed
  artifacts. There is no Redis, object-store service or additional web service.

- **`frontend/`** — SolidJS + Vite + Tailwind + Solid UI. Built to static
  assets at image-build time and served by the backend from the same origin,
  so there's exactly one port to expose.
- Access is invite-only, using email verification codes and an HTTP-only
  session cookie; jobs are scoped to the signed-in account. State survives a
  page reload because the frontend retrieves the current job from the backend.
- **SSE job updates** send comment heartbeats every 15 seconds, with
  `Cache-Control: no-cache` and `X-Accel-Buffering: no`, so quiet, long-running
  jobs keep their live status stream open through proxies. The stream subscribes
  before reading its fresh initial status snapshot to avoid missing a terminal
  update that races with connection setup, and unsubscribes when it closes.

### Persistent artifact reuse

Reusable work is never bypassed by a request flag (`no_cache` was removed in
options schema 3). Independent producer versions live in
`separator/cache_versions.py`; captured native/model identities live in
`separator/model_manifest.json`. Changing UI, documentation, app name, GPU type,
mix name, pitch or tempo does not invalidate recognition, alignment, source pitch
or raw stems. Normal deployments reuse the manifest's immutable native image,
not a fresh resolution of floating dependencies. There is no TTL or global
release/Git-SHA cache key.

The web data volume stores private `artifacts/sources`, `key-decode`, `keys`,
and `transforms` files. YouTube aliases use the video ID (different video/version
IDs remain distinct); other URLs retain their full identity. The first download,
including key preview, captures artist/track metadata. Each job receives its own
original-byte copy; output title tags never mutate a shared source. Key preview
and processing share decoded-audio analysis, including a valid unknown (`null`)
result. Uploaded filenames and browser sessions do not enter content keys.

The VPS data volume also stores versioned stems/mixes, source-clock transcripts,
raw recognition/alignment, structure and pitch artifacts. A hit is checked before
any model call. Raw Qwen output survives reference/alignment changes; new
pitch/tempo requests reproject source-clock data and reuse native audio transforms.
Baseline MMS keys include decoded PCM, sample rate, raw recognition and the
aligner's model/dependency identity. Changed acoustics invalidate its timings
even when words agree; Qwen-only changes do not invalidate alignment when PCM
and raw chunks agree. Custom mix IDs/names do not enter audio keys. Successful
LRCLIB records retain their exact-version cache and are revalidated before use.

Model weights remain on the existing **read-only** Modal volume. Shared verified
weight receipts are separate from private computed-output namespaces: a cold
quality test does not redownload or rehash gigabytes for each case. Preparation
runs on CPU before dispatch; GPU stages have outbound networking disabled.
Canonical in-root Hugging Face links bind the resolved weight bytes, not the
symlink text. Image-bundled CREPE weights have their own actual captured digest.

Validated results publish atomically under local per-key filesystem locks.
There is no distributed FUSE-lock assumption. SQLite globally claims a semantic
stage before dispatch, including across different jobs. Recorded call IDs resume
after restart, and returned artifacts must match the exact request fingerprint.
If acceptance may have occurred but the call ID was not committed, equivalent
jobs fail visibly with **“Model dispatch uncertain; not automatically repeated”**
until an operator reconciles the intent; this is not an exactly-once claim.
Completed cache artifacts win before any such claim or GPU lookup.

Caches remain private implementation details, not public routes or shared
history. Ordinary upgrades preserve existing job files and opaque historical cache.
Administrators can open **People → Manage cached songs** to inspect indexed
reusable audio work and, after confirmation, clear one song, selected songs or
all reusable cache. A selective clear can also evict artifacts shared with other
recordings. Older unattributed cache cannot safely be cleared by song: selective
clearing remains unavailable until an administrator separately confirms clearing
all reusable cache; no legacy reset happens automatically. Clearing can make
future processing download or recompute data and incur GPU costs; saved jobs,
original files, named downloads, karaoke
reference audio, accounts and model weights remain intact. Active, queued or
unresolved work can block clearing; the server reports that conflict without
removing the selection.

Migration imports verified original bytes without relabeling unknown producers.
Historical producer aliases require actual GPU-runtime evidence; a CPU image
inspection alone is insufficient. Raw historical Qwen reuse additionally needs
its exact decoded-source metadata when no matching complete transcript exists.
Missing provenance is an explicit migration constraint, not permission to
silently repeat recognition or invent old word alignment.

Cache regressions use owned synthetic audio and explicitly versioned CPU
producers, not neural-quality substitutes. They observe real work, forbid a
second producer call on valid hits, exercise independent versions and process
restarts, and verify private HTTP results/history. Abrupt-dispatch tests cover
acceptance before call-ID commit and equivalent new jobs. Genuine reference-text
changes reuse recognition and baseline alignment but can require new
reference-dependent acoustic alignment. Neural-quality gates remain separate.

### Text-assisted YouTube Music discovery

`POST /api/song-search` accepts `{"query":"artist, title, or lyric clue"}` and
returns HTTP 202 `{"search_id":"opaque ID","status":"pending"}` after reusing
cached successful matches or queuing local work, not after provider inference.
`GET /api/song-search/{search_id}` returns `{"status":"pending"}` or
`{"status":"done","songs":[{"title":"…","artists":["…"],
"url":"https://music.youtube.com/watch?v=…","duration_seconds":214,
"thumbnail_url":null,"play_count":2700000000,"play_count_approximate":true}]}`.
Successful results contain **one to three** songs; duration, artwork and plays
may be `null`. Poll every two seconds; polls read durable search state
and never spawn another model request. Browser voice
input is browser dictation into this same text field, not server audio upload.

Whitespace is normalized; the 500-character limit admits a spoken paragraph
while bounding model input (not whole lyrics/documents). Search does not create
audio jobs, download music, or change processing options. Selecting its grounded
URL feeds the existing source/key-preview workflow; processing still requires
the normal explicit submission.

The SQLite `song_searches` table keeps opaque IDs, signed-session ownership,
creation time and terminal results/errors. A single independent VPS worker claims
pending queries transactionally. Pending normalized text is stored privately for
restart recovery and cleared on completion/expiry; it is not retained as search
history. Existing nullable historical call IDs and rows remain readable.
Migration preserves custom indexes and triggers. Audio jobs and public options
are unchanged.

Successful matches are shared across requests for **24 hours (86,400 seconds)**
from their **first validated successful persistence**, not from search start or
the most recent cache hit. Keys use the existing whitespace-normalized query
(case and Unicode text preserved), discovery producer version, model, OpenRouter
endpoint and HTTP dependency revision. A hit creates a new session-owned handle
with the original success timestamp and validated matches, without contacting
Modal, OpenRouter or YouTube Music. Cached copies do not extend freshness.
At exactly 86,400 seconds, or after a query/producer identity change, a new search
is required. Pending, failed and abandoned/unpolled searches are not successful
query-cache entries; malformed cached matches fail explicitly rather than
falling back to a song or retry. Concurrent cold misses remain independently
owned searches, serialized by the local search worker.

Separately, **all handles still expire after 15 minutes (900 seconds)** from
creation and require the originating signed session cookie, including after
process restart. This short lifetime and the pending-search guard are not
extended by the one-day result cache. Foreign, unknown and expired handles return
404 without contacting a provider. No match is 404; ambiguity is 422; malformed
model/catalog output is 502; remote unavailability is 503.
Errors use the usual `{"detail":"…"}` envelope. Completed polls read durable
terminal state; closing the browser stops polling but does not cancel owned work.

Song discovery runs in the **VPS CPU worker**, with no Modal allocation or local
LLM. Both text extraction and catalog selection still use
[OpenRouter chat completions](https://openrouter.ai/docs/api/reference/overview)
with the explicit model `z-ai/glm-4.7-flash` (listed in the
[public model catalog](https://openrouter.ai/api/v1/models/z-ai/glm-4.7-flash/endpoints)).
Requests use JSON mode, temperature zero and at most 256 output tokens.
GLM's optional default-on thinking is explicitly disabled using OpenRouter's
[reasoning control](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
so reasoning does not consume the small visible-JSON budget.
Only endpoints supporting those parameters are eligible; normal OpenRouter
provider routing/account preferences remain in effect. There are no application
retries, alternate-model fallbacks or local text-model loaders.

Configure the authorized application's **`OPENROUTER_API_KEY`** only in the
backend's server-side secret environment. Do not put it in frontend settings,
chat, source control or coding-assistant credentials. The VPS makes outbound
HTTPS requests to OpenRouter and YouTube Music; the GPU pool receives no provider
secret. Account credits and provider access must permit this model.
Missing credentials or authentication/billing/rate-limit
failures return a safe 503 error. HTTP requests have 5-second connect and
30-second read timeouts; redirects are rejected and provider response bodies
are not exposed in public errors. Search clues and candidate metadata are sent
to OpenRouter and its selected model provider, but not browser/session IDs,
audio bytes, job history or application credentials in prompt content.
On a query-result cache miss, the model extracts supplied clues into search text
(validated not to invent artist/title words), then identifies relevant versions
from at most **eight** fresh public YouTube Music **song** candidates via
`ytmusicapi==1.11.5`. Artist, song and explicit remix/version intent take priority:
unrelated songs, samples, mashups and other artists' covers are excluded unless
requested. Different songs or artists that fit equally remain ambiguous;
popularity is not used to resolve that ambiguity. Lyric clues go to catalog
search as lyrics, not a model's guessed artist. Catalog HTTP connect/read
timeouts remain 5/15 seconds; the remote function remains capped at 180 seconds.
User and catalog text are untrusted prompt data. The model returns only distinct
supplied IDs, never URLs, metadata, counts or uncatalogued IDs; invalid
selections/abstentions fail explicitly, never falling back to the first song.

Popularity is the **YouTube Music song catalog's reported plays**, not individual
YouTube video views or artist totals. English song renderers label this value
“plays”; the pinned library's `parse_song_run` exposes it under the misleading
`views` key after stripping that label. Catalog requests explicitly use English.
Validated `K`/`M`/`B` abbreviations expand numerically for sorting and set
`play_count_approximate: true`; exact whole counts, including zero, set it false.
Missing, malformed or browser-unsafe integer counts become `null` with a false
approximation flag. No additional song-detail requests, model estimates or
mixing with per-video view counts are used.

After relevance selection, known play counts sort descending, including zero
before unknown counts; ties preserve catalog relevance order. The top three
available matches are returned, not a claim to the global most-played recordings.
Repeated catalog IDs are discarded, but distinct IDs are never merged merely
because title, artist or duration coincide. Original version/remix titles remain
visible. Artwork comes only from trusted HTTPS Google/YouTube image-provider
URLs already supplied by the catalog; missing or unsafe URLs become `null`.
The backend does not download images or audio for discovery.

`DATA_DIR/song-search-cache` stores versioned, validated discovery inference
artifacts on the VPS. Keys include the explicit model, OpenRouter endpoint,
HTTP dependency revision, inference/prompt version and complete relevance inputs
(candidate IDs, titles, artists and durations). Artwork URLs and popularity are
not sent to the model. Cached selected IDs map to **current** catalog metadata
before sorting, so artwork/count changes alone do not rerun semantic inference.
Catalog searches are fresh whenever the one-day query-result cache misses or
expires; successful plural results, including their metadata snapshot, retain
the same 24-hour lifetime. The discovery-only producer identity invalidates old
single-match query/inference cache entries without deleting their rows or files.
Discovery never invalidates audio caches. Preserve/import compatible existing
discovery artifacts during the CPU-worker cutover instead of paying for them again.

## Choosing outputs

The original source remains downloadable and unchanged by processing, preserving
the uploaded file's extension. URL downloads retain the existing yt-dlp MP3
workflow. A completed job with no generated audio has an empty result manifest;
its original download remains available in Results when the job is open. Lyrics
are a separate optional text output and do not create an audio stem. Selecting
**Karaoke with pitches** also includes and locks **Lyrics with pitches** (TXT and
ODT); disabling it restores the previous independent preference.

In this source, expanded results show **Karaoke with
pitches**, **Lyrics with pitches**, then **Lyrics**. Completed History entries
remain compact, showing title, status, date, key, adjustments, an audio-output
count and an action to open Results. Open Results for lyrics, individual audio
and pitch JSON downloads when present. Timestamped lyrics remain visible while
online-alignment and raw-recognition diagnostics are initially collapsed in
the **Online alignment and raw recognition details** disclosure.

Each signed-in user can delete their own completed History entries after a
confirmation. Deletion permanently removes that job's history, original upload
or download, saved outputs, and private karaoke vocal reference; it does not
remove shared reusable cache or another user's jobs. Active transfers or
unresolved inference ownership can block deletion. Stop an active transfer and
retry; unresolved or unsafe data may require operator investigation. If file
deletion encounters an I/O error, the job remains in History for retry, but some
of its files may already have been removed. Queued, running, and failed jobs
cannot be deleted.
The owner-protected `DELETE /api/jobs/{id}` returns **204** on success, **404**
for a missing or other user's job, **409** for an ineligible or unsafe deletion,
and **503** if file removal fails.

Existing completed karaoke jobs with both saved transcript and pitch data expose
their derived TXT and ODT downloads in Results without reprocessing. Pitch-only
jobs without saved lyrics do not offer these downloads.

Each generated MP3 embeds a `Title` tag identical to its canonical download
filename without the `.mp3` extension. This title includes the output stem and
any source-key, pitch, and tempo descriptors present in the filename. If the
source key is unknown, no source-key descriptor or placeholder is added. The
original download is never retagged; its bytes remain unchanged.

Native players use owner-protected **listening** requests (`?playback=1`) while
download links keep their original URLs and bytes. Standalone MP3 audio at
16 kHz or higher is privately re-encoded as 256 kbps AAC-LC in a faststart,
seek-indexed MP4 container, with edit-list timing and sample timescale preserving
the source clock. This conversion applies only to private listening copies of
original audio, generated outputs and the timeline's private vocal reference.
It is lossy, not packet-copying or bit/headroom-preserving, and may alter peaks,
including creating over-full-scale peaks.

Listening copies are prepared locally on demand and cached by source content,
FFmpeg/FFprobe binary revisions and the listening-algorithm version. The v2
playback-cache change invalidates only listening-copy entries; it does not
regenerate other cached source, key, stem, lyrics or analysis data. Eligible
preparation failures are visible errors, not silent fallback to the inaccurate
raw stream. MP3 below 16 kHz and other input formats retain their existing
behavior. Original and generated downloads, embedded download titles, analysis
inputs, pitch/lyric timestamps and tempo-clock mappings are unchanged; this is
not a transcription or alignment-model correction. Linux WebKit and Chromium
playback and seeking were verified; physical iPhone/AVFoundation playback
remains untested.

When **Extract lyrics** is selected, the worker looks up an exact-version lyric
reference from credible music metadata, independently recognizes the full source
vocals with [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B), and
aligns supported reference phrases to the actual audio with MMS CTC. Missing
metadata or a provider outage uses the new unprompted recognizer without a
reference. This is **reference-aligned candidate text, not verified lyrics**:
conflicting variants, unconfirmed lines and unsupported word timings remain
explicit. See [reference-first lyrics](#reference-first-lyrics-and-audio-alignment).

Reference stanzas are partitioned into alignment contexts of at most 30 seconds,
each covering its anchors. Reuse of a published ASR word span requires validated
provider bounds, an exact unambiguous span, and no existing disputed candidate
or weak-word conflict; reused timings are not presented as fresh CTC measurements.
The reference policy changes only the final reference-transcript cache key;
changed CTC contexts get distinct stage keys. Unchanged raw ASR/MMS, key, stem,
download and pitch caches remain reusable.
For legacy records missing PCM metadata, CPU decoding must reproduce the exact
MMS baseline identity and validate its producer provenance before recording
metadata; otherwise processing fails closed, without rerunning raw ASR/MMS.

In one My Way replay, accepted line onsets increased from 24/37 to 36/37 and
canonical words from 154 to 235, retaining all 24 prior lines and 154 prior word
positions; the largest prior onset shift was 53.4 ms. Twelve newly accepted
lines' onsets differed from unprompted-ASR first anchors by a median 5.3 ms and
maximum 105.4 ms; these are not human annotations or accuracy guarantees. One
line remains unconfirmed. Existing saved transcript and pitch indices are not
rewritten; a new run rebuilds lyrics and word associations while reusing raw
pitch data.
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
| Karaoke with pitches | Musical-note karaoke timeline and pitch JSON (output audio clock), timestamped lyrics with pitched TXT/ODT downloads, and included `vocals`, `instruments`, `drums`, `bass`, `other-instruments`, and `drums-vocals` downloads |
| Extract vocals | `vocals` |
| Extract lyrics | Timestamped TXT and lyrics/provenance JSON (original audio clock) |
| Lyrics with pitches | Aligned pitch-over-word TXT/ODT per vocal stem, shown when the job is open (output audio clock) |
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

**Karaoke with pitches** is the first output option, marked with a decorative
microphone. Selecting it includes and locks **Extract vocals**, **Extract
lyrics**, **Extract instruments**, and **Split drums, bass & other instruments**.
Every newly processed karaoke job therefore offers five backing choices:
Full song, Just vocals, Instruments, Drums only, and Drums + Vocals. Drum separation also
produces public **bass** and **other-instruments** downloads, not just drums.
The unchanged original is retained; existing pitch/tempo rules determine
whether an additional transformed full-song download is generated.
Hover an included option or focus/tap its **Why?** button for an immediate
explanation; Escape dismisses it. Turning karaoke off restores each output's
previous manual choice, including a drums-only selection without a public
instrumental download. The preview and submitted request use the same included
outputs. No user-configured one-part mix is inserted; existing custom mixes,
vocal splits, cleanup, and standalone pitched-lyrics choices remain independent.
Karaoke with pitches also exports **Drums + Vocals**, mixed from the selected
cleaned vocal and drum stems before pitch and tempo adjustments. Existing jobs
show this backing only if it is present in their manifest; no historical
processing is triggered.
On a cold cache, the instrumental and drum/bass/other separation models add
processing work. Compatible already-computed stages are reused from cache;
this is not a promise that the additional outputs are cost-free.

**Lyrics with pitches** remains a separate text-output mode: it does not select
karaoke or expose its internal vocal/lyric-analysis prerequisites as downloads.
For API requests, `detect_pitch=true` also exports the canonical
`drums-vocals` mix; isolated vocals and drums remain internal unless requested,
and private vocal playback can be recovered from cache. Older stored jobs keep
their existing manifests. All options remain off by default.

The source selector offers **From URL**, **Upload audio**, and **Find song**.
In Find song, enter a title, artist, or description (up to 500 characters), then
select **Search** or press **Enter** in the query. Typing alone does not search;
Enter never submits audio and is ignored during an active search or IME composition.
While the search is pending, the form shows
**Finding on YouTube Music…**. Results offer up to three matching versions,
with title/version, artists, duration, a 48px square cover when available, and
a **YouTube Music** verification link for each. Missing or failed artwork keeps
the same square space without obscuring the choice. These are bounded matching
catalog results, not a claim to include every version on YouTube.

Versions retain the server's ranking by **YouTube Music plays** when available.
Rounded catalog counts are labeled **About** and displayed compactly; exact
counts keep their digits. Unavailable counts are distinct from a real zero.
These are Music plays, not per-video YouTube views or LLM-estimated popularity.
The first result is selected automatically. Tap/click another version, or use
the radio controls with arrow keys/Space, to switch the canonical URL and key
preview. Enter on a version selects it without submitting audio. A processing
job is created only when you select **Download song** or **Process audio**.
Editing the query, clearing the selection, or switching source modes invalidates
the match and cancels browser polling/key preview, so an old match cannot be
processed for a new query. This does not cancel remote model work already started.
URL, upload, and query drafts remain separate; processing options and mixes stay
in place. Submission retains the selected match and query just like other sources.

Where `SpeechRecognition` or Safari's prefixed `webkitSpeechRecognition` is
available, a microphone button offers user-initiated dictation. It fills the
query only: select **Search** or press **Enter** afterward. The button switches
to **Stop voice input** while listening, and permission, network, and no-speech failures leave
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
Download-only remains the default, and pitch/tempo never modify the original.
Reusable analysis has no cache-bypass control. After submission, the source selection
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
**Extract lyrics** or **Karaoke with pitches** as well still shows those requested
views; selecting karaoke also includes its lyric and complete backing-track outputs.

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
The browser score preserves its system UI monospace/DejaVu Sans Mono preferences,
then tries Courier New before the generic monospace fallback. This keeps the
combining-Latin/Cyrillic grid aligned on systems whose generic mono font has
different combining-character advances; full-width CJK cells still occupy two
columns.
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
# Isolated stored-analysis lane: real browser downloads, no GPU jobs.
npm --prefix frontend run test:e2e -- --visual --config=playwright.seeded.config.ts pitched-lyrics-odt.spec.ts
```


## Vocal pitch detection

**Karaoke with pitches** enables the pitch timeline (`detect_pitch`), independently
of the global musical-key estimate or pitch-shift control. In the browser it also
includes vocals, lyrics, instruments, and drum/bass/other separation; API clients
and older saved jobs can still contain pitch-only analysis. It analyzes every selected vocal-only
stem: full/decrowded vocals, male/female, lead/backing, and selected dry versions.
Instrument stems and vocal-plus-instrument mixes are never passed to the
monophonic estimator. When an API request selects no vocal output, full vocals
are extracted internally for analysis without adding a vocal download.

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

Word chips show only the lyric text, without appended note counts; literal
numbers in lyrics are preserved. Selecting a word still seeks its first linked
note and highlights all associated notes, or uses its word onset when unlinked.

A **−5 s / Play–Pause / +5 s** row sits immediately above the karaoke lyrics,
below the graph and selection details. The center icon and accessible action
follow the native player's actual state, including external pauses and source
changes; failed playback is reported rather than shown as playing. Native audio
controls, including volume, remain below the karaoke reader. All controls use
the same player. Skips move five seconds on the selected audio's native clock,
clamp to its available duration, and preserve playing/paused state, volume,
background source and selected stem. Lyrics remain mapped to the output clock.

With focus on the timeline's scroll region or time ruler, **Space** toggles that
same native player without scrolling the page; holding Space does not repeatedly
toggle playback. Space also works in the lyric reader when text is selected, but
not while typing in an input. It does not clear a browsing pause. Focused notes
and word buttons retain their selection actions, as do other controls.

In this source, vocal pitch analysis includes a piano
below the audio player. Its initial range centers the minimum and maximum notes
across all analyzed vocal tracks and fills the available viewport with extra keys;
every pitch remains reachable by scrolling. Detected notes illuminate only for
the selected vocal track on its output clock while it is playing. Press and hold
keys with a pointer, touch, Space or Enter for an independent synthesized
piano-like tone; the view remains stable during a held note, which sustains and
fades briefly on release. An icon-labelled vertical **Piano volume** control to
the right of the keyboard adjusts only these manually played tones, including
notes currently held; zero is silent and does not affect the song or backing
track. Its default sound level is doubled while the slider still starts at 100%;
volume is not saved between sessions. Detection does not produce automatic piano
sound. The instrument uses browser Web Audio rather than samples, suspends when
idle, and reports unavailable audio.

With **Follow playback** enabled, the timeline advances when the playhead passes
about 75% of the visible note area, excluding the sticky note axis, leaving room
to see upcoming notes. Manually panning by wheel, touch, scrollbar or keyboard
pauses auto-follow while you browse. Only a manual horizontal return
that brings the current playhead back into the visible note region resumes it,
after the gesture finishes; the sticky note axis does not count as visible time.
The clock moving into a stationary browsed view, seeking, skipping, source
changes and restarting playback do not resume following. Turning Follow off is
an explicit opt-out; turning it back on does not clear an existing browsing
pause. Browsers without native scroll-end events use a best-effort
stationary-frame fallback for gesture completion.
A seek in the native audio controls reveals the playhead even with Follow off,
without clearing an existing browsing pause.

The karaoke reader centers the current lyric line and a dimmed next timed line.
Natural progression slides the next line upward; seeks jump directly, and
reduced-motion preferences suppress animation. Known words fill progressively
using published timings and the same output clock; untimed words remain neutral.
An optional **Pitches** row shows only unambiguously linked notes from the
selected vocal track above each word. Each word reserves room for its linked
notes; the inline reader can wrap word groups and long note sequences. No syllable
timings or note links are invented. Pitch-only or ASR-gap words can appear as
short individual cues.

The inline lyric size starts at twice the previous base size; **A−** and **A+**
adjust it from 75% to 400% in 25% steps. The choice is shared within the view
and is not stored between sessions. Fullscreen centers the current and next
lines together and fits them, including associated pitches, without wrapping.
Its **A−** can reduce the text; **A+** stops at the largest size that fits.
Very long lines or note sequences may therefore appear small. Fullscreen
recomputes the fit when the content, settings, or viewport changes.
Fullscreen keeps the current player, backing and position, with a scrollable
backing picker, pitch toggle, play/pause, five-second skips and a seek bar.
The fullscreen progress bar follows the selected audio's own clock, which can
differ from the output clock when the untransformed original plays at a changed
tempo. Exit or Escape returns to the previous view; keyboard Space controls
playback when focus is not on an interactive control.

**Background audio** is independent of the detected **Vocal stem** selector.
Choose **Full song** (the transformed song when available, otherwise the
unchanged original), **Just vocals** (all vocal parts, not necessarily the
selected detected voice), **Instruments**, **Drums only**, or
**Drums + Vocals**. New karaoke submissions include the required outputs.
Older stored jobs do not gain missing stems automatically: their unavailable
choices remain disabled. Run **Karaoke with pitches** again to produce missing
outputs, reusing compatible cached stages rather than silently launching work
when a background is selected. With tempo-only adjustments and selected stems,
Full song still uses the unchanged original at original speed, mapped to the
output clock; nonzero pitch also produces the transformed full-song reference.
A cleaned instrumental is not silently substituted for the instrumental output.
Other exported detected vocal
stems remain available. The default reference is **Full song**, preserving the
appropriate output-clock mapping. Accessible background buttons preserve the output-clock
position, playback state and volume. During a switch the existing source keeps
playing until the replacement is ready and aligned; a failed replacement leaves
the old source playing. A newer selection or external player takeover prevents
an outdated switch from resuming it. Only one HTML audio player is audible at a
time. Selecting another history job resets its playback and reference state.
Source-picker rows shrink within mobile cards, so long transformed-stem labels cannot widen the device viewport or displace note tap targets.

New pitch-timeline jobs retain their already-computed full-vocal prerequisite
as a private listening reference even when **Extract vocals** was not selected.
It receives the same pitch/tempo audio transform as public outputs, but is not
added to the download manifest. `JobDTO.has_pitch_vocals` reports actual persisted
availability; the owner-protected
`GET /api/jobs/{id}/pitch-reference/vocals` serves either this private file or an
existing public full-vocal result.

Older pitch-only jobs offer **Recover cached vocals** when their original is
still stored. The owner-protected endpoint reads exact private artifacts on the
VPS using captured producer identity, then applies the existing local transform.
It never allocates Modal compute, redownloads a source, loads a neural model,
reruns separation/recognition/pitch, or adds public outputs. New jobs already
retain their private vocal reference. Historical artifacts need verified producer
provenance rather than a guessed CPU/GPU native-library fingerprint. Missing or
corrupt exact artifacts remain explicit errors, not hidden inference retries.

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

**Download pitch JSON** is available from Results and, when available, History
through the session-protected `/api/jobs/{id}/pitch` endpoint. The same canonical
payload appears as `pitch` in job detail/history/SSE. Version 1 includes model,
source/output durations, requested pitch/tempo, explicit output timestamp/pitch
references, and per-stem `tracks`. Each note has `start_s`, `end_s`, fractional
`midi`, `frequency_hz`, `note`, residual `cents`, `confidence`, and `word_indices`
into the shared timed `words` list. New lyric jobs identify `word_alignment` as
`torchaudio/MMS_FA`, or `null` when word alignment is unavailable. Historical
`whisper-approximate` data remains readable. The private finite-stage RPC does not
replace the public transcript/pitch schemas or pretend that historical unknown
recognizer identities are current. Old whole-job RPCs are not compatibility shims.

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
- Every derived stem card in Results, including when opened from History, shows
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
  previews. Preview and submission share persistent source/key artifacts,
  including valid unknown keys; submission does not repeat completed analysis.

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

`uv sync --frozen` includes the development tools pytest, Ruff and ty. NumPy is
also used by independent numerical-oracle tests of the moved pitch
postprocessing. Production CPU audio decoding and assembly use NumPy, SoundFile
and soxr; they do not install Torch, Qwen, MMS, CREPE or SongFormer on the VPS.
Production installs continue to exclude the development group.

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

The retained **remote primary GPU interpreter stays on Python 3.13**, while
its existing ASR and structure environments stay on **Python 3.12**. These are
separate frozen native environments, not a backend Python pin or a reason to
re-resolve model dependencies during source deployment. Shared `separator/`
source therefore targets Python **3.12** syntax in Ruff; backend type checking
targets 3.15. An unpaid local compatibility proof compiles every separator
module and imports the reachable pure helpers under actual 3.12 and 3.13
interpreters, without loading neural dependencies. It also exercises the
finite request/result binding and verifies identical producer identity hashes
across those interpreters; actual GPU-host native provenance is checked by the
required real-model CI gate.

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

The source's account policy gives administrators unlimited invitation slots and
alone allows them to revoke unused invitations or disable accounts; regular users
have a configurable allowance of three by default.
Administrators can grant one more slot and inspect a member's recent activity,
including available job titles and search queries. Historical timestamps or
queries that were not recorded remain unknown. See
[ACCESS_PLAN.md](ACCESS_PLAN.md) for historical deployment notes.

On 2026-11-09, production application commit
`c527bb43509759c217e62e07311e5a393f9ce9cf`, image digest
`sha256:c72d57a6b3762490cb8027ca51eff2e765223c84642175e8aa84cb20f27fbcef`,
and VPS configuration commit `f3e36c2ef36ff4ca3a6367ede3623127a2ccbf34`
were verified with public health 200 and anonymous jobs access 401. This is a
historical observation, not a claim about the release currently running. For
the current image pin and rollout status, check the VPS's canonical
`nixos/audio-deployment.yaml` and running deployment.

The server requires its two authentication secrets and origin. Without an SMTP
socket, OTP delivery fails and sign-in cannot complete. For local-only
development, run the existing E2E Unix SMTP sink in a **separate terminal**;
it writes OTPs to private local files and sends no mail:

```sh
umask 077
export AUTH_DEV_DIR="$HOME/.cache/vocals-auth-dev"
mkdir -p "$AUTH_DEV_DIR"
node --input-type=module -e 'import {startAuthSmtp} from "./frontend/e2e/auth-smtp.mjs"; await startAuthSmtp(process.env.AUTH_DEV_DIR); console.log("Local SMTP sink ready");'
```

In the application terminal, create two independent keys once and retain them
across local restarts. Keep the files and invitation/OTP values private:

```sh
umask 077
export AUTH_DEV_DIR="$HOME/.cache/vocals-auth-dev"
mkdir -p "$AUTH_DEV_DIR" dev-data
test -s "$AUTH_DEV_DIR/otp-key" || openssl rand -hex 32 > "$AUTH_DEV_DIR/otp-key"
test -s "$AUTH_DEV_DIR/invite-key" || openssl rand -hex 32 > "$AUTH_DEV_DIR/invite-key"
export AUTH_OTP_SECRET="$(cat "$AUTH_DEV_DIR/otp-key")"
export AUTH_INVITE_SECRET="$(cat "$AUTH_DEV_DIR/invite-key")"
export AUTH_ORIGIN="http://localhost:5173"
export AUTH_ADMIN_EMAIL="admin@example.test"
export AUTH_SMTP_SOCKET="$AUTH_DEV_DIR/smtp.sock"
export AUTH_TRUSTED_PROXY_CIDRS=""
DATA_DIR="$PWD/dev-data" uv run python -m backend.auth_admin seed-invite
make dev
```

Open the URL Vite prints, normally `http://localhost:5173`; `AUTH_ORIGIN` must
match the browser's actual frontend origin, not the backend's port 8000. Use the
private seed invitation to register the configured admin email, then read its
local OTP from `$AUTH_DEV_DIR/mail-admin%40example.test`. Run `seed-invite` only
when a new seed invitation is needed. The backend (`uvicorn --reload` on
`:8000`) and Vite run together; Ctrl-C stops both. Stop the separate SMTP sink
when finished. Local job data, uploads and results use `./dev-data/`.

### Lint / typecheck

```sh
make lint
```

Run `make test` for backend/domain/native tests (including simulated-boundary
HTTP tests), and `make test-frontend` for jsdom/Vitest tests. Native audio
scenarios require the tools above and are skipped when those executables are
unavailable. These suites are not a substitute for exercising deployed GPU
inference and real browser downloads.

### Lower-cost isolated GPU tests

CI uses two explicit, isolated test apps: **L4** for the eleven shorter GPU
smokes, then **L40S** for the full-song/short-tail structure smoke and all 68 live
browser cases. Each app is stopped after its phase; this is not an automatic
retry on larger hardware. Production keeps **L40S** when `MODAL_TEST_GPU` is
absent; production promotion requires it to be unset. Each app uses one `infer`
pool for five finite operations:
a separator pass, raw Qwen recognition, MMS alignment, CREPE frame prediction,
and full-context SongFormer prediction. Cache lookup, reference HTTP, final
transcript/section/note assembly, mixes, exports, song discovery and recovery
run on the VPS, without acquiring a GPU.

The override accepts only `L4` or `L40S` and requires an explicit, nonblank
`MODAL_APP_NAME` other than `audio-separator`, `audio-separator-v2` or
`audio-inference-v3`, without surrounding whitespace.
If `E2E_MODAL_APP_NAME` is set, it must match.
An override also binds the source app's default name to that isolated target.
Modal's CLI can still override this with `--name`: **keep `--name`,
`MODAL_APP_NAME`, and `E2E_MODAL_APP_NAME` identical**. The guard does not
reinterpret CLI arguments.
Unset `MODAL_TEST_GPU` and clear isolated app-name variables before deploying
production.

[Modal's published GPU rates](https://modal.com/pricing) are $0.000222/second
for L4 ($0.7992/hour) and $0.000542/second for L40S ($1.9512/hour).
That is about **59% less per GPU-second**, not a promise of 59% less per test run:
L4 must take less than approximately **2.44 times** the L40S total billable GPU
allocation time, including startup and idle time, to reduce the GPU portion of
the bill. CPU, memory, storage and external APIs are additional costs;
whole-suite wall time is not the sum of billable GPU allocation time.

[L4 has 24 GB GPU memory and BF16 support](https://www.nvidia.com/en-us/data-center/l4/),
versus L40S's 48 GB. The unchanged full-song structure smoke completed its
approximately 141-second input on L4, but its required **420.02-second** padded
short-tail case exhausted memory inside MuQ attention: a 6.57 GiB allocation
was requested with only 5.41 GiB free. The longer case therefore runs explicitly
on production-class L40S; it is not clipped, split into shorter model contexts,
or replaced with a warm-cache-only assertion.

Model identities, precision, batching, source lengths, resource limits,
timeouts and artifact versions do not change with the hardware override.
All existing real-model and live-browser coverage remains required.
An out-of-memory or timeout failure stays visible, without a silent GPU
fallback or reduced assertions. The local deployment-boundary tests require
no Modal allocation. The full CI run is the hardware-fit/performance proof,
rather than an additional duplicate neural smoke run.

The pool has `min_containers=0`, `buffer_containers=0` and `max_containers=1`.
`MODAL_GPU_IDLE_SECONDS` accepts a positive integer and defaults to **60 seconds**.
This is an explicitly unoptimized initial baseline, not a measured savings
claim. Change that deployment setting only after comparing actual allocation,
startup and idle intervals; it is not part of an algorithm or artifact key.
CI reads the nonsecret repository Actions variable `MODAL_GPU_IDLE_SECONDS`,
falling back to 60 in both isolated and production deployment jobs. After
reviewing measured data and obtaining release-owner approval, set that variable
and redeploy the same source/image with only this infrastructure setting changed.
Subsequent CI deployments preserve the chosen value; this neither changes GPU
type nor enables automatic tuning.

“Short” means one bounded native model operation, not a five-second deadline or
arbitrary audio clipping. Full-song contexts, intrinsic decode/STFT/model
preparation and required neural postprocessing remain intact.

### Real full-stack verification

`make test-e2e` (equivalently `npm --prefix frontend run test:e2e`) builds the
production frontend, serves it from a real uvicorn backend, and drives Chromium
through the UI. It requires Modal credentials and an **explicit isolated**
`E2E_MODAL_APP_NAME`; the harness rejects all protected production names:
`audio-separator`, `audio-separator-v2` and `audio-inference-v3`.
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
export MODAL_APP_NAME="$E2E_MODAL_APP_NAME"
export MODAL_TEST_GPU=L40S
trap 'uv run modal app stop --env "$MODAL_ENVIRONMENT" -y "$E2E_MODAL_APP_NAME" || true' EXIT
uv run modal deploy --env "$MODAL_ENVIRONMENT" separator/modal_app.py --name "$E2E_MODAL_APP_NAME"
make smoke
make test-e2e
```

On NixOS, use a native Chromium executable through
`E2E_CHROMIUM_EXECUTABLE=/path/to/chromium` and install Playwright's recording
helper with `npx --prefix frontend playwright install ffmpeg`. The direct GPU
smoke also uses the shared voiced fixture, so it requires Node and FFmpeg.

For a focused real-model mixer proof using the isolated app deployed above:

```sh
MIXER_EVIDENCE_DIR=/tmp/stem-mixer-proof \
  uv run pytest -m smoke tests/test_mixer_smoke.py -s
```

This uses the isolated app's shared, verified, read-only model weights and a
private local computed-artifact cache, then starts a real local HTTP server and
queue. It processes the licensed voiced fixture through
all four requested pairs, a three-component mix, and all four
vocal-variant/instrument mixes. Downloaded audio, Title tags, timing, stereo/48 kHz,
peak levels, hidden prerequisites and unchanged original bytes are checked.
The cleanup case additionally compares mixes against independently exported real
cleaned/dry component audio. The local server is released on exit; the deployment
cleanup trap above stops the Modal app. Shared weights are never deleted.
MP3s and `proof.json` remain in the evidence directory. Deterministic local tests
separately measure per-component spectral amplitudes, non-normalized sums,
multichannel alignment, overload limiting, unsafe/duplicate names, privacy,
interrupted-job recovery, retry and historical migrations.

The live-queue Chromium browser matrix covers processing/behavior, unknown
keys, download metadata, native MP3 uploads, responsive workspaces,
adjustments, retained forms, lyrics, exclusive playback, vocal pitch and
pitched lyrics. A required stored-analysis lane separately covers
authentication, karaoke/piano, native pitch-timeline interaction and ODT
exports at desktop/mobile widths. These disjoint lanes retain their behavior
cases. The separate native-listening, visual and manual YouTube suites are
excluded from the live-queue matrix.

The browser harness bootstraps an account once through a real invitation and
email OTP; fresh browser contexts share that account and its persistent history,
so result assertions are scoped by job ID rather than global totals or an empty history.

Historical stored-analysis cases publish their existing synthetic/captured pitch
fixtures directly. Complete Karaoke fixtures instead execute the production
CPU processing graph and persistent warm-cache reuse through an explicitly
synthetic finite producer, with real temporary model/config hashes and native
FFmpeg provenance. These cheap lanes run with empty Modal/OpenRouter credentials
and a deliberately nonexistent production manifest. `--visual` disables the
normal queue; each owned publisher requires isolated data and an unclaimed
queued job. This proves CPU assembly, public artifacts and browser behavior,
not neural quality. CI requires the complete seeded lane before paid GPU work:

```sh
node frontend/e2e/run.mjs --visual --config=playwright.seeded.config.ts
```

To run just the authentication cases through the same mandatory seeded config:

```sh
node frontend/e2e/run.mjs --visual --config=playwright.seeded.config.ts auth.spec.ts
```

The dedicated Firefox listening regression uploads original, aperiodic synthetic
VBR audio and drives the real Results player through the owner-protected HTTP
API. A transparent test-only relay paces actual audio responses at 64 KiB/s,
preserving Range/HEAD, status, headers and bytes; the audio response is not
mocked. The processing queue is disabled, so no model job runs. Muted native
capture, independent full-decode reference crops and natural-play calibration
check that a seek beyond the buffered region keeps decoded content within
100 ms of the player clock, with confident waveform matches. Only this case
runs in Firefox; the Chromium matrix is not duplicated.

```sh
node frontend/e2e/run.mjs --visual --throttle-media --config=playwright.listening.config.ts
```

This requires the matching Playwright Firefox installation and native tools.
The case retains PCM/clock diagnostics and the harness retains
`test-results/visual/listening-transport.json`; CI runs it before any GPU work.

The six discovery cases exercise five viewport widths (375/390/430/1440/2560),
explicit search, three-version selection with tap/keyboard, canonical URL
key-preview handoff, loaded/missing/failed square artwork, approximate/zero plays,
stale-source protection, 16px inputs, 44px choice targets, and no automatic job creation.
The sixth simulates the prefixed Web Speech API for deterministic dictation and
permission/lifecycle coverage; it does **not** prove a physical microphone or
actual Safari. Vitest additionally covers polling cancellation, provider errors,
Unicode normalization, race ordering, clear selection, retry, retained mixes,
one-result auto-selection, stale key cancellation when changing versions,
exact/approximate/unknown/zero plays, unsupported browsers, and stale speech
callbacks. Run these browser cases with
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
from Results and again after reopening the job from History; FFprobe checks that
the embedded Title equals Chromium's suggested filename without `.mp3`, including
the source name, stem, source key, pitch, and tempo. Both generated downloads must be
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
  unobstructed Results downloads and playback, including jobs opened from
  History. The all-enabled processing case additionally captures all 21 selected
  outputs at all seven widths and checks that source-key chips and download names
  stay within the viewport; its pitched full-song output is shown in the output
  preview. A native-scale
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

The `backend-exit.json` artifact records the spawned `uv` wrapper's
exit code, signal and `shutdownRequested` state, plus available cgroup-v2
memory-event counters before and after the run (or `null` when unavailable).
The wrapper status is not necessarily the direct Uvicorn status, and counters
alone do not automatically attribute a failure to OOM.
The long-interval Playwright job-status polls for vocal pitch and pitched lyrics
request `Connection: close`; they still fail on HTTP errors, but do not exercise
pooled connections on those polling paths. This is a test-client choice, not a
claim about the cause of a previous reset.

Local domain tests exhaust independent audio-output boolean combinations and
exercise arbitrary mix selections with decoded waveform/spectral assertions.
These are deterministic local checks, not thousands of GPU runs or a proof over
arbitrary numeric pitch/tempo values.

Pull requests run the cheap deterministic/native, frontend, isolated Firefox,
seeded browser and visual checks. Paid GPU and live-queue gates run for main
pushes and explicitly opted-in manual runs; their full assertions remain intact.
Only a passing main run promotes **`audio-inference-v3`** and publishes the
matching web image. Main is already a release branch: batching changes before a
main push, rather than merely renaming a run “release,” avoids duplicate paid
gates. Old `audio-separator-v2` remains operational until the matching web
cutover and drain; unrelated legacy deployments and all model volumes remain
untouched. Promotion requires the complete native, listening, seeded,
full-stack, GPU and visual gates.
The separate manual YouTube workflow is not a release dependency.

The shared CI native-tool installer replaces only inherited Azure Ubuntu archive
URLs with `https://archive.ubuntu.com/ubuntu`, including hosted-runner mirror
lists; repository suites, components, signing keys and release deadlines remain
unchanged.

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
release prerequisite. It complements the functional, native-listening and visual
suites, including the explicitly controlled discovery UI cases.
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

The screenshot cases compare committed PNGs in
`frontend/e2e/visual-snapshots/`: three 390px mobile Outputs/Adjust/Review
screens, two 1440px/2560px desktop workspaces, eight tightly cropped focused
pitch/tempo controls (390px and 1440px, each with zero/C major, +2/D major,
undetermined key, and long fractional cents), two detected-vocal timelines
with linked sung words (390px/1440px), two reference-aligned provenance
views with inline uncertainty and raw recognition (390px/1440px), two
synthetic pitched-lyrics typography views covering Unicode word cells,
repeated-note melisma and explicitly untimed lines (390px/1440px), two mix
builder/review cases, two karaoke-output dependency/help views (390px/1440px),
and four song-discovery pending/selected cases (390px/1440px), including three
version rows, square artwork/fallbacks, and play-count availability. These
complement, not replace, the functional browser E2E cases.
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
catalog fixtures and synthetic artwork (including a failed image).
No external recording is fetched or Modal function called by
visual tests; existing audio/key cases continue to use real native consumers.
Each case uses a fresh browser context and pinned viewport, scale, clock, locale,
timezone, colors, fonts and CPU rasterization; native audio metadata is loaded
before timeline capture. Animations are disabled and the caret hidden.
Only the two detected-vocal timeline pixel comparisons mask the browser-owned
`<audio>` controls; their bounds still determine the mask region. Every case
retains an **unmasked** `actual.png` for review. App-owned footer buttons,
timeline notes, karaoke, labels and layout remain pixel-tested; native playback,
seeking and volume remain covered by functional browser tests.
Comparisons allow **zero differing pixels** above a strict **0.005 YIQ color
threshold** (only about one RGB level of minor raster color rounding);
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
| `DATA_DIR` | `/data` | Persistent SQLite, uploads, results and reusable source-clock artifacts |
| `QUEUE_CONCURRENCY` | `1` | VPS audio DAG workers; `0` disables their admission during operator reconciliation |
| `MODAL_ENVIRONMENT` | `ehpc-audio` | Explicit environment for every backend RPC lookup; a nonblank value overrides the default, while missing/blank/whitespace values use the default, never an ambient profile's `main` |
| `MODAL_APP_NAME` | `audio-inference-v3` | Finite GPU pool exposing only `infer` |
| `MODEL_VOLUME_NAME` | `audio-separator-models` | Existing verified model volume; mounted read-only in the GPU pool |
| `PRODUCER_MANIFEST` | `separator/model_manifest.json` | Exact captured image, native producer identities and consumed model assets |
| `PREPARED_MODELS_ROOT` | `$DATA_DIR/artifacts` | Private shared weight-verification receipts; independent of computed-output namespaces |
| `MODAL_TEST_GPU` | *(unset)* | Strict isolated-test-only `L4` or `L40S` override; production remains `L40S` |
| `MODAL_GPU_IDLE_SECONDS` | `60` | Positive GPU idle-window seconds, a deployment setting rather than an algorithm version |
| `OPENROUTER_API_KEY` | *(unset)* | Server-only VPS discovery credential; never sent to Modal or browsers |
| `AUTH_OTP_SECRET` | *(required)* | Stable secret of at least 32 bytes for OTP verification; distinct from the invitation secret |
| `AUTH_INVITE_SECRET` | *(required)* | Stable independent secret of at least 32 bytes for invitation derivation |
| `AUTH_ORIGIN` | *(required)* | Exact browser origin; HTTPS in production, loopback HTTP for development |
| `AUTH_ADMIN_EMAIL` | `ehpc@ehpc.io` | Seed-invited administrator's email |
| `AUTH_SMTP_SOCKET` | `/run/audio-mail/submit.sock` | Unix SMTP socket; development may use the local E2E sink |
| `AUTH_TRUSTED_PROXY_CIDRS` | *(empty)* | Only immediate trusted proxy networks; production use requires an enforced gateway-only ingress policy and raw ASGI peer |

## Running on Kubernetes

1. **Build and push the image:**

   ```sh
   docker build -t ghcr.io/ehpc/ehpc.io-audio:prod .
   docker push ghcr.io/ehpc/ehpc.io-audio:prod
   ```

2. **Prepare existing model assets and deploy the new GPU pool before web
   cutover**, from a machine with Modal credentials:

   ```sh
   export MODAL_ENVIRONMENT=ehpc-audio
   export PREPARED_MODELS_ROOT=/private/audio-prepared-models
   uv run python -m separator.prepare_models \
     --manifest separator/model_manifest.json \
     --volume audio-separator-models --environment "$MODAL_ENVIRONMENT" \
     --prepared-models-root "$PREPARED_MODELS_ROOT" \
     --receipt separator/model_assets_receipt.json
   unset MODAL_TEST_GPU E2E_MODAL_APP_NAME MODAL_APP_NAME
   make deploy-modal
   ```

   On the VPS, import the same receipt into the actual persistent
   `PREPARED_MODELS_ROOT` (normally `/data/artifacts`) before enabling model
   admission. A receipt written on a developer machine or CI runner does not
   populate the web pod's PVC. This command reads existing volume metadata and
   writes local verification receipts; it does not start compute or download
   model weights. Credentials and the selected environment must resolve the
   captured volume; there is no fallback to another environment.

   CI and `make deploy-modal` target **`audio-inference-v3`** in **`ehpc-audio`**.
   This is a breaking internal RPC cutover, not a compatibility alias: never
   replace `audio-separator-v2` while old web instances still call its whole-job
   functions. New web instances call only `infer`.

   The manifest selects the retained immutable producer image plus new local
   source mounts. Ordinary deployment does not re-resolve floating pip/apt
   dependencies. `separator/build_image.py` is the separate, intentional native
   producer-update path; a new image requires fresh captured provenance.
   The GPU pool has no provider secret or workload network access. Model weights
   remain on the existing read-only Modal volume, including verified in-root HF
   symlinks; the bundled CREPE weights retain their image provenance.
   A separate private read/write Volume carries staged requests and completed
   results. Its name is derived by
   `separator.inference_transport.transport_volume_name(app, environment)`:
   `audio-transport-` followed by 32 hexadecimal characters. Deployment and the
   VPS must use the same explicit app/environment; every isolated CI app gets
   its own transport volume, never the production or model-weight volume.

   All audio **and** potentially large alignment/reference parameters are
   uploaded by the VPS before model dispatch. The Function RPC carries only a
   persisted opaque transfer token, not large pickled inputs or results that
   would make the SDK access blob-storage URLs inside the network-blocked
   container. The GPU verifies the staged request fingerprint, publishes the
   complete output and checksum receipt, commits the Volume, and returns a small
   token. The VPS streams and verifies that private result before publishing the
   validated local artifact. Model failures retain full private diagnostics;
   only a bounded typed failure crosses RPC. No provider Internet access,
   workload S3 credentials, model changes or cache-version bump is needed.
   Share preparation receipts across isolated test output roots so a cold-output
   proof does not stream gigabytes of already verified weights again.
   Historical checksum attestations retain their snapshot date and current
   metadata cross-check limits. CPU asset inspection verifies weight bytes; it
   does not establish the GPU runtime's FFmpeg executable/library fingerprint,
   even for the same immutable image. The manifest uses the actual GPU-observed
   fingerprint, corroborated against retained historical artifact keys, rather
   than substituting the inspection runtime's identity. Strict native admission
   checks remain enabled. A rejected pre-model call can reveal a fingerprint
   mismatch but is not successful inference, quality or hardware-fit evidence;
   the complete real GPU gate is still required.

   Preserve/copy completed artifact bytes to the VPS before cutting over
   existing cached work. The bounded CPU-only importer accepts a trusted private
   inventory of exact paths, types, sizes and content SHA-256 values:

   ```sh
   uv run python -m separator.migrate_artifacts \
     --volume audio-separator-models --environment "$MODAL_ENVIRONMENT" \
     --destination-root /data/artifacts \
     --source-inventory /private/completed-artifacts.json \
     --path analysis-results/structure/EXACT_COMPLETED_KEY.bin
   ```

   Repeat `--path` for the selected completed artifacts. The importer verifies
   bytes, atomically publishes validated files, rejects conflicts and never
   removes old volume data. Publishing a legacy producer alias additionally
   requires `--producer-manifest` and `--verified-gpu-receipt` from successful
   real calls across the five operation families; CPU asset receipts alone
   cannot authorize it. Raw Qwen-only caches also need proven decoded-PCM
   metadata for their old alignment keys. Missing provenance is a cutover
   prerequisite to resolve, not permission to silently repeat recognition.
   Existing complete transcript caches are checked before that raw-stage path.

   Preserve `/data`, original job files and all stable auth secrets. Drain
   active audio/search work and block new upload admission before terminating
   old web instances. Verify new web behavior and required legacy-cache hits,
   then stop the old `audio-separator-v2` app without deleting its volumes.
   The unrelated legacy `audio-separator` app remains protected. Public options
   remain schema 3; this internal transport change does not rewrite job options
   or infer unknown historical model provenance.

3. **Provision cluster resources:**
   - A single-writer `PersistentVolumeClaim` mounted at `/data` — holds SQLite,
     uploads, results, source-clock artifacts and private preparation receipts.
   - A `Secret` with `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`.
   - A `Secret` with distinct stable `AUTH_OTP_SECRET` and
     `AUTH_INVITE_SECRET`, each at least 32 bytes.
   - A server-only `OPENROUTER_API_KEY` secret for local song discovery.
     Keep it out of the GPU app, image layers and browser environment.

4. **Deployment**, `replicas: 1` (see [Architecture](#architecture)):
   use the prepared `ehpc.io-configs/k8s/120-audio/` manifests rather than a
   floating image tag. They preserve the single-writer PVC and render the host
   mail-socket group dynamically. The production gateway trust, NetworkPolicy
   enforcement, node probes and secret provisioning are release gates; see
   [ACCESS_PLAN.md](ACCESS_PLAN.md). The prepared access changes are not yet
   deployed.

Configure the pod's `preStop` exec hook as `python -m backend.drain`, readiness
as `GET /ready`, and liveness as `GET /health`. The hook contacts the
mode-0600 `/tmp/vocaltools-<uid>/drain.sock` in a mode-0700 directory; it is
not an HTTP endpoint. It stops new compute admission and queue claims, waits for
admitted work and discovery to finish, and lets an accepted inference finish
and persist its cache. An audio job needing another
uncached stage is requeued for the next pod; fully cached work can finish.
Only after that work is quiescent does the hook acknowledge completion. Uvicorn's
`--timeout-graceful-shutdown 5` then limits lingering HTTP connections.

Kubernetes counts the hook against its termination grace. The model's 1200-second
execution timeout does not bound provisioning, queueing, or transport, so no
fixed grace guarantees a graceful checkpoint. If a pod is forcibly killed,
recorded call IDs remain resumable; a dispatch whose acceptance is uncertain
fails closed and requires operator reconciliation rather than automatic GPU
resubmission. Older pods without this hook must be drained separately before
they are terminated.

Keep the single CPU queue and existing 1 GiB limit initially. One isolated
1-core, 1-GiB/no-swap, network-disabled capacity run processed a 356.8-second
uncompressed float32 stereo source through five synthetic finite-model outputs,
real CPU assembly/mixing, seven audio/text/document exports and SQLite. It
peaked at **595.25 MiB**, completed in **98.84 seconds**, and recorded no OOM
events. That proves this bounded scenario, not neural quality or a universal
working-set bound for longer inputs/concurrent work. Measure actual working
sets before buying a larger VPS.

### Reconciling an uncertain model dispatch

A persisted stage intent without a recorded Modal call ID blocks equivalent
work across jobs, including after restart. The public error is honest:
“Model dispatch uncertain; not automatically repeated.” A transport failure
after acceptance cannot be treated as proof that no GPU work ran.

The private request journal also persists its opaque transfer ID before dispatch.
Successful transfers are deleted remotely only **after** local validation,
file/directory fsync and a durable cleanup-pending acknowledgment. A local write
failure retains the accepted call and remote result; a cleanup failure retains
the pending acknowledgment, not permission to repeat inference. Restarted jobs
can consume the same recorded call, and cache hits retry pending cleanup.
This ordering is recoverable, not a transaction spanning SQLite and Modal.
There is no age-based deletion of unresolved accepted work. For a known terminal
model failure, the VPS first verifies and fsyncs the complete private diagnostic,
persists its size/SHA and cleanup acknowledgment, and records the job as failed.
Only then may remote input/diagnostic files be deleted. A crash or deletion
failure leaves retryable cleanup debt; repeated requests replay the recorded
failure locally rather than submitting the model again.

Diagnostics remain under `$DATA_DIR/artifacts/inference-diagnostics` with
directory mode `0700` and file mode `0600`; they are not job downloads and no
public diagnostic endpoint exists. The static frontend fallback also resolves
and confines requested files to its own build directory, rejecting encoded
traversal, absolute paths and outward symlinks. Filesystem permissions alone
would not protect diagnostics from an unconstrained web-server file response.
Local failure evidence is retained for operators alongside job history; remote
cleanup never deletes those local diagnostics or unresolved accepted work.

Completed-transfer cleanup also runs before a new audio job and can be invoked
without starting a GPU:

```sh
uv run python -c 'from backend.inference import cleanup_completed_transfers; print(cleanup_completed_transfers())'
```

It checks the recorded size/SHA of the local artifact or terminal-failure
diagnostic before deleting only that acknowledged transfer. It does not delete
unresolved intents, weights, old job
files or other applications' data. CI may remove its exact owned transport
volume only after stopping its isolated app and confirming no tasks remain.
Failed CI runs retain that private volume for operator diagnostics; cleanup
requires capturing the failure evidence and verifying the app is stopped and
drained. Never apply a TTL or blanket deletion to unresolved production work.
Storage/cleanup and intrinsic GPU filesystem I/O still have costs; this design
does not claim free transport or an unmeasured reduction in billed allocation.

First block new admission and drain/stop every audio worker; run the private
operator command against the same persistent `DATA_DIR` with
`QUEUE_CONCURRENCY=0`. `--admission-drained` is an operator attestation, not an
automatic cluster-wide lock. If a known call completed successfully, attach it:

```sh
QUEUE_CONCURRENCY=0 uv run python -m backend.reconcile_inference \
  --job-id OWNER_JOB_ID --admission-drained --call-id VERIFIED_COMPLETED_CALL_ID
```

The command reads that existing call, matches its transfer token, and verifies
the committed result's request fingerprint, size and SHA before attaching it.
Pending, failed or mismatched calls cannot be adopted. If control-plane evidence instead proves
that no call was accepted, release only the unresolved intent:

```sh
QUEUE_CONCURRENCY=0 uv run python -m backend.reconcile_inference \
  --job-id OWNER_JOB_ID --admission-drained --verified-not-dispatched
```

Never use release merely because the call ID is unknown. It refuses a recorded
call and preserves historical job status/error/files. After reconciliation,
restore normal admission: an equivalent request can consume the validated
completed result or submit the proven-undispatched stage. There is no public
reconciliation endpoint or automatic uncertain-dispatch retry.

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

- Access uses invite-only email OTP; see [ACCESS_PLAN.md](ACCESS_PLAN.md) for
  historical deployment and account-policy notes.
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
correction evidence remain readable without rewriting database rows. Stored
analysis retains canonical nullable confidence and provenance; the finite GPU
protocol does not retain alternate whole-job RPCs for old callers. The new
production app is deployed alongside the old one until web cutover is complete.

Stored records without an explicit recognizer/alignment identity keep that
identity unknown (`null`), including results persisted by an older web worker.
Neither historical probabilities nor word intervals
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

The noncommercial structure smoke uses the same finite inference pool and
verified read-only model weights as the other real-model checks. Native CPU
postprocessing and full-context neural predictions retain the complete
public-domain recording and short-tail assertions; there is no separate
sleeping sandbox, runtime upload/exec protocol, or warm-output substitute.
Cheap synthetic fixtures exercise transport, CPU assembly, cache reuse and
browser behavior, not neural accuracy. The complete real GPU gate remains
required before release.
