# Vocal Tools

A web app for downloading a song, transforming its pitch/tempo, or extracting
selected vocal and instrument tracks. Submit a URL or upload a file: by default,
only the original song is kept, with **no GPU separation**. Explicitly choose
vocals, instruments, cleanup/split outputs, or female/male/backing vocals mixed
with instruments. Play or download the results. Multiple people can use it at
once; submissions go through a queue, and each visitor sees their live position.

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
                                                  separator/modal_app.py ("audio-separator" Modal app)
                                                                │
                                                                ▼
                                                     GPU container on Modal
                                                     (audio-separator + models)
```

- **`separator/`** — pure domain logic (stem-model configs, the actual
  separation pipeline, URL download, and CPU audio analysis/postprocessing)
  plus `modal_app.py`, which defines the Modal app and GPU function. This is
  the only place that knows about CUDA images, GPUs, or `audio-separator[gpu]`.
- **`backend/`** — the always-on FastAPI app. It downloads/reads the source and
  detects its key with libkeyfinder. Download-only jobs and whole-song pitch/tempo
  changes run locally, without calling Modal (even with cache bypass enabled).
  When separation outputs are selected, it submits to the *deployed* Modal
  function, polls for completion, and persists results. Rubber Band R3 applies
  pitch/tempo changes locally to each final output, after any mixing. A small
  SQLite-backed queue caps concurrent jobs.
- **`frontend/`** — SolidJS + Vite + Tailwind + Solid UI. Built to static
  assets at image-build time and served by the backend from the same origin,
  so there's exactly one port to expose.
- Users are identified by an anonymous, signed HTTP-only cookie (no login).
  State survives a page reload because the frontend re-derives "what's my
  current job" from the backend on mount, rather than storing it client-side.
- **This app is single-pod by design (`replicas: 1`).** The SQLite file (one
  writer), the in-process job-claim lock, and the SSE pub/sub used for live
  updates all assume exactly one running process. Don't scale the Deployment
  horizontally or pass `--workers` to uvicorn.

## Choosing outputs

The original source remains downloadable and unchanged by processing, preserving
the uploaded file's extension. URL downloads retain the existing yt-dlp MP3
workflow. A completed download-only job has an empty result manifest; its original
download is still available in Results and History.

| Selection | Output labels |
|---|---|
| Extract vocals | `vocals` |
| Extract instruments | `instruments` |
| Remove crowd noise from vocals | `vocals-decrowded` |
| Remove crowd noise from instrumental | `instruments-decrowded` |
| Split by gender | `vocals-male`, `vocals-female` |
| Split lead & backing | `lead`, `backing` |
| Split drums, bass & other instruments | `drums`, `bass`, `other-instruments` |
| Female vocals + instruments | `female-instruments` |
| Male vocals + instruments | `male-instruments` |
| Backing vocals + instruments | `backing-instruments` |

- Cleanup/split outputs work without selecting their parent extraction. Required
  intermediate tracks are internal unless their own output is selected.
- Dereverb adds a `-dry` counterpart to each selected vocal output. **Dereverb
  alone**, with no other output selection, produces only `vocals-dry`.
  Instrument-only + dereverb does not add a vocal track. Mix-only + dereverb
  dries the mix's vocal prerequisite without exposing a standalone dry track.
- Vocal splits use decrowded vocals when vocal crowd removal is selected.
  Mixes use those splits, their dry versions when dereverb is selected, and
  decrowded instruments when instrumental crowd removal is selected.
- Download order is vocal wet/dry pairs (`vocals`, decrowded vocals, male,
  female, lead, backing), then instrumental outputs, then female, male, and
  backing mixes. A shared prerequisite/model pass runs only once.
- Mixes are simultaneous audio sums, not concatenations: FFmpeg aligns both
  inputs to stereo/48 kHz and sums at unity gain (`amix normalize=0`). A
  latency-compensated peak limiter with **no automatic makeup gain** reduces only
  excessive peaks; its 0.89 ceiling leaves about 1 dB of MP3 reconstruction
  headroom. Quiet passages are not averaged down or automatically boosted.
  Mixing precedes pitch/tempo rendering, and separation caches remain raw.
- Stored jobs from before explicit extraction are migrated to request both base
  stems, preserving their history and retry behavior.

## Pitch, tempo, and musical key

- **Pitch shift (semitones):** `0` is unchanged; positive values transpose up,
  negative values down. Fractional semitones are supported.
- **Tempo (% of original):** `100` is unchanged, `120` is 20% faster, and `80`
  is 20% slower. Tempo must be positive. Pitch and tempo are independent.
- With no separation selections, changing pitch or tempo produces a full-song
  `song` output locally, displayed as **Full song** with the applied pitch
  shift in semitones and/or tempo as a percentage of the original. The original
  is always displayed as **Original (unchanged)**. Identity settings produce no
  extra output.
- Every final output (including mixes and the full song) is rendered using one
  offline Rubber Band **R3/Finer** pass with both settings together and formant
  preservation. There is no separate pitch-first or tempo-first pass.
  Separation caches remain unmodified; identity settings bypass rendering.
- Modified downloads identify their settings, for example
  `Song - vocals - pitch+2st - tempo120pct.mp3`. The original audio download
  is never modified.
- Results and history show the estimated **original key** and **output key**.
  The original is analyzed once using Mixxx's libkeyfinder; the output key is
  derived from the pitch offset, preserving major/minor mode. Fractional
  offsets include residual cents. Tempo alone does not change the key.
- Key detection is an estimate of a global major/minor key, not chord or
  modulation tracking; silence is shown as **Undetermined**. Historical jobs
  without key analysis also show Undetermined. Large pitch/tempo changes can
  introduce audible artifacts.
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
  when submitting by URL — `ffmpeg` converts the download, and `deno` lets
  `yt-dlp` solve YouTube's anti-bot challenge (without it, some downloads
  fail with `HTTP Error 403: Forbidden`). Both are already included if you
  use the Nix devShell below.
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
`E2E_MODAL_APP_NAME`; the harness refuses the production `audio-separator` name.
It allocates loopback backend/source-server ports and a temporary `DATA_DIR`,
serializes GPU jobs, and removes its servers and temporary state afterward.
It never uses `dev-data/`, request interception, fake Modal calls, or a fake key
detector.

With the native tools above, Python/Node dependencies installed, and Modal
credentials configured:

```sh
npm --prefix frontend ci
npx --prefix frontend playwright install --with-deps chromium
export E2E_MODAL_APP_NAME="audio-separator-e2e-$(date +%s)"
trap 'uv run modal app stop -y "$E2E_MODAL_APP_NAME" || true' EXIT
uv run modal deploy separator/modal_app.py --name "$E2E_MODAL_APP_NAME"
MODAL_APP_NAME="$E2E_MODAL_APP_NAME" make smoke
make test-e2e
```

On NixOS, use a native Chromium executable through
`E2E_CHROMIUM_EXECUTABLE=/path/to/chromium` and install Playwright's recording
helper with `npx --prefix frontend playwright install ffmpeg`. The direct GPU
smoke also uses the shared voiced fixture, so it requires Node and FFmpeg.

The browser matrix contains **27 cases**, not just one “everything on” job:

- Each of the 12 boolean controls is submitted individually, plus all 12
  together. Independent cleanup/splits and mix-only cases prove that internal
  prerequisites do not appear as extra downloads.
- Mixes with dry vocal prerequisites, both crowd-cleanup selections plus dry
  mixes, and instruments-only plus dereverb exercise dependency-sensitive paths.
- Identity, positive/negative fractional pitch, pitch-only, tempo-only,
  speedup/slowdown, and transformed separated output exercise native processing.
  Another all-options case applies fractional pitch and a tempo change to all
  20 derived tracks, checking every modified name/duration while preserving the
  original. The identity all-options case remains the raw mix-composition proof.
  Whole-song changes prove expected audio duration and the known generated
  fundamental's pitch shift; originals are downloaded and hash-checked.
- Cache bypass alone proves no Modal call is made. A separate explicit
  extraction warms through the browser, repeats with zero raw inference time,
  and bypasses with positive inference time. Persisted queue timestamps and
  actual Modal call IDs are included in the evidence.
- File and real HTTP URL inputs exercise key preview and yt-dlp downloads;
  spinner/progress, target keys/notes, stale-key clearing, invalid audio/source
  errors, retry after source recovery, reload/history, and session isolation are
  covered through browser interactions. The dedicated sustained C/E/G triad
  checks known-key accuracy (`C major`) independently of the complex voiced
  song. Both qualified fixtures assert `C major`, and their actual native preview
  must also agree with the UI, persisted original key, and mathematical target
  key/notes after transposition.

The hosted stereo `C major` → `G major` failure was **not musical ambiguity**:
the upstream keyfinder-cli compatibility path for FFmpeg 6 and older supplied
the channel-layout **bitmask** (`3` for stereo) where libkeyfinder requires a
channel **count** (`2`). That misinterprets sample timing by 3/2 and shifts C to G.
The native regression checks known C-major audio in both mono/stereo and
WAV/MP3, so an octave-equivalent mono result cannot conceal this decoder bug.
The shared native build applies the exact decoder channel-count correction
after verifying the upstream source checksum, for both CI and the Docker image.

Every successful processing case downloads its exact manifest, checks public
filenames/modification suffixes and absent hidden outputs, decodes every audio
track in Chromium and FFmpeg, and measures channels, timing, finite samples,
signal, and peak levels. The all-enabled case additionally compares each mix's
PCM against the aligned unity-gain sum of its actual downloaded vocal and
instrumental components. This checks real mixing, not just nonempty files.

Artifacts are under `frontend/test-results/`: per-case `proof.json` with options,
manifest, queue/Modal evidence, hashes and audio measurements; downloaded audio;
completion screenshots; and `backend.log`/`summary.json`. Failures retain
screenshots, video, and Playwright traces. The HTML report is in
`frontend/playwright-report/`. There are no automatic test retries. CI additionally
emits GitHub annotations for failed assertions and stops on the first failure;
a successful gate still executes all 27 cases with no skipped cases.

Both local domain suites also exhaust all **4096 boolean combinations** for
output/dependency contracts (including raw-cache policy). That is local
combinatorial verification, **not** 4096 GPU runs or mathematical exhaustiveness
over arbitrary numeric pitch/tempo values.

CI runs native/backend/frontend checks, direct deployed GPU smoke, and this
browser matrix against a unique test app for every push/PR. Only a passing main
run promotes the production Modal deployment and publishes the image.

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
| `MODAL_APP_NAME` | `audio-separator` | Deployed Modal app name to look up |
| `MODAL_FUNCTION_NAME` | `separate` | Deployed Modal function name to look up |
| `COOKIE_SECRET` | *(insecure dev default)* | Signs the session cookie — **must** be set to a stable secret in prod; rotating it logs everyone out |
| `COOKIE_SECURE` | `false` | Set `true` in prod (behind TLS) — a `Secure` cookie is silently dropped over plain HTTP, which is why local dev defaults to `false` |

## Running on Kubernetes

1. **Build and push the image:**

   ```sh
   docker build -t ghcr.io/ehpc/ehpc.io-audio:prod .
   docker push ghcr.io/ehpc/ehpc.io-audio:prod
   ```

2. **Deploy the updated Modal GPU function before releasing matching backend/UI
   changes** from a machine with Modal credentials:

   ```sh
   make deploy-modal
   ```

   New extraction/mix options require the current graph; an older deployed
   function is not compatible with the new defaults/output contract. Redeploy
   after changes to `separator/stems.py`, `separator/options.py`, or the Modal
   image. The runtime uses CUDA 12.6.3/cuDNN on Ubuntu 24.04 (FFmpeg 6+ is required
   for latency-compensated limiting), with `audio-separator[gpu]==0.44.1` and
   `librosa==0.11.0` pinned to the exercised compatible stack. Coordinate the
   rollout; local source-only jobs and key previews do not need Modal credentials.
   For verification without overwriting a deployment, run the current
   `separator.modal_app.app` inside `with app.run():` and invoke its bound
   `separate.remote(...)`. `make smoke` targets the deployed function and now
   checks explicit extraction and mix-only outputs, not implicit default stems.

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

## Known limitations

- No login/auth beyond the anonymous per-browser cookie — anyone with the URL
  can submit jobs. Job history and downloads are scoped to that signed cookie.
- No automatic cleanup of old uploads/results — `/data` grows unbounded.
- Single-pod only, as noted above.
