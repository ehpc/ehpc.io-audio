import { createEffect, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { createStore } from "solid-js/store";
import type { BooleanOptionKey, JobDTO, SeparationOptions } from "~/api";
import { analyzeKey, audioSettingsError, submitJob } from "~/api";
import { Button } from "~/components/button";
import KeyNotes from "~/components/KeyNotes";
import { Label } from "~/components/label";
import { TextField, TextFieldInput } from "~/components/text-field";
import { displayOutputLabel, expectedStems } from "~/lib/expectedStems";
import { transposeKey } from "~/lib/music";

type SourceMode = "url" | "file";
type WorkspaceTab = "outputs" | "adjust" | "review";
type AudioOptionKey = "pitch_semitones" | "tempo_percent";
const WORKSPACE_TABS: WorkspaceTab[] = ["outputs", "adjust", "review"];
const OPTION_GROUPS = ["Outputs", "Mixes", "Cleanup", "Splits"] as const;

interface OptionDescriptor {
  key: BooleanOptionKey;
  label: string;
  mobileLabel?: string;
  group: typeof OPTION_GROUPS[number];
}

const PROCESSING_OPTIONS: OptionDescriptor[] = [
  { key: "extract_vocals", label: "Extract vocals", group: "Outputs" },
  { key: "extract_instruments", label: "Extract instruments", group: "Outputs" },
  { key: "extract_lyrics", label: "Extract lyrics", group: "Outputs" },
  { key: "mix_female_instruments", label: "Female vocals + instruments", mobileLabel: "Female + instruments", group: "Mixes" },
  { key: "mix_male_instruments", label: "Male vocals + instruments", mobileLabel: "Male + instruments", group: "Mixes" },
  { key: "mix_backing_instruments", label: "Backing vocals + instruments", mobileLabel: "Backing + instruments", group: "Mixes" },
  { key: "mix_lead_instruments", label: "Lead vocals + instruments", mobileLabel: "Lead + instruments", group: "Mixes" },
  { key: "decrowd", label: "Remove crowd noise from instrumental", mobileLabel: "Crowd off instruments", group: "Cleanup" },
  { key: "decrowd_vocals", label: "Remove crowd noise from vocals", mobileLabel: "Crowd off vocals", group: "Cleanup" },
  { key: "dereverb", label: "Dereverb (remove reverb)", mobileLabel: "Remove reverb", group: "Cleanup" },
  { key: "genders", label: "Split by gender (male/female)", mobileLabel: "Male / female", group: "Splits" },
  { key: "lead_backing", label: "Split lead & backing vocals", mobileLabel: "Lead / backing", group: "Splits" },
  { key: "drums", label: "Split drums, bass & other instruments", mobileLabel: "Drums / bass / other", group: "Splits" },
];

const DEFAULT_OPTIONS: SeparationOptions = {
  extract_vocals: false,
  extract_instruments: false,
  extract_lyrics: false,
  mix_female_instruments: false,
  mix_male_instruments: false,
  mix_backing_instruments: false,
  mix_lead_instruments: false,
  decrowd: false,
  decrowd_vocals: false,
  dereverb: false,
  genders: false,
  lead_backing: false,
  drums: false,
  no_cache: false,
  pitch_semitones: 0,
  tempo_percent: 100,
};

const SubmitForm: Component<{ onSubmitted: (job: JobDTO) => void }> = (props) => {
  const [mode, setMode] = createSignal<SourceMode>("url");
  const [url, setUrl] = createSignal("");
  const [file, setFile] = createSignal<File | null>(null);
  const [options, setOptions] = createStore<SeparationOptions>({ ...DEFAULT_OPTIONS });
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [originalKey, setOriginalKey] = createSignal<string | null>(null);
  const [analyzing, setAnalyzing] = createSignal(false);
  const [analyzed, setAnalyzed] = createSignal(false);
  const [analysisError, setAnalysisError] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<WorkspaceTab>("outputs");
  const [mobile, setMobile] = createSignal(false);
  onMount(() => {
    const query = window.matchMedia?.("(max-width: 700px)");
    if (!query) return;
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });
  const showTab = (next: WorkspaceTab, focus = false) => {
    setTab(next);
    if (focus) document.getElementById(`tab-${next}`)?.focus();
  };

  createEffect(() => {
    const currentMode = mode();
    const currentUrl = url().trim();
    const currentFile = file();
    setOriginalKey(null);
    setAnalyzed(false);
    setAnalyzing(false);
    setAnalysisError(null);
    if (currentMode === "url") {
      try {
        const parsed = new URL(currentUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) return;
      } catch {
        return;
      }
    } else if (!currentFile) return;
    const controller = new AbortController();
    setAnalyzing(true);
    const analyze = async () => {
      try {
        const result = await analyzeKey(
          currentMode === "url" ? { url: currentUrl } : { file: currentFile! },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setOriginalKey(result.original_key);
        setAnalyzed(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        setAnalysisError(err instanceof Error ? err.message : "Key analysis failed.");
      } finally {
        if (!controller.signal.aborted) setAnalyzing(false);
      }
    };
    const timer = setTimeout(() => { void analyze(); }, currentMode === "url" ? 600 : 0);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });
  const targetKey = () => transposeKey(originalKey(), options.pitch_semitones);
  // Keep number inputs uncontrolled so intermediate "-" and decimal input
  // are not overwritten while their valueAsNumber is temporarily NaN.
  let pitchInput!: HTMLInputElement;
  let tempoInput!: HTMLInputElement;

  // Direct entry stays fractional (step="any"); buttons move by one semitone
  // or one percentage point without crossing tempo's exclusive zero bound.
  const canAdjust = (key: AudioOptionKey, delta: -1 | 1) => {
    const next = options[key] + delta;
    return Number.isFinite(next) && next !== options[key] && (key !== "tempo_percent" || next > 0);
  };
  const adjust = (key: AudioOptionKey, input: HTMLInputElement, delta: -1 | 1) => {
    if (!canAdjust(key, delta)) return;
    const next = options[key] + delta;
    input.value = String(next);
    setOptions(key, next);
  };

  // The source is always retained. Lyrics are a separate non-audio output.
  const trimmedUrl = () => url().trim();
  const stems = () => ["original", ...expectedStems(options)];

  const validationError = (): string | null => {
    const hasUrl = mode() === "url" && trimmedUrl().length > 0;
    const hasFile = mode() === "file" && file() !== null;
    if (!hasUrl && !hasFile) {
      return "Provide a URL or choose a file to upload.";
    }
    return audioSettingsError(options);
  };

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    const invalid = validationError();
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setSubmitting(true);

    const usingUrl = mode() === "url";
    const chosenUrl = trimmedUrl();
    const chosenFile = file();
    const submittedOptions = { ...options };
    try {
      const result = await submitJob({
        url: usingUrl ? chosenUrl : undefined,
        file: usingUrl ? undefined : chosenFile ?? undefined,
        options: submittedOptions,
      });
      props.onSubmitted({
        id: result.id,
        status: result.status,
        position: result.position,
        source_type: usingUrl ? "url" : "upload",
        source_value: usingUrl ? chosenUrl : chosenFile!.name,
        // A URL's title is resolved server-side after download; an upload's
        // filename is its title.
        title: usingUrl ? null : chosenFile!.name,
        original_key: null,
        output_key: null,
        options: submittedOptions,
        manifest: null,
        transcript: null,
        error_message: null,
        created_at: Math.floor(Date.now() / 1000),
        has_original: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form class="audio-workspace" data-active-tab={tab()} onSubmit={handleSubmit}>
      <section class="source-panel" aria-label="Audio source">
        <div class="source-line">
          <div class="source-tabs" role="group" aria-label="Source type">
            <For each={["url", "file"] as SourceMode[]}>
              {(value) => (
                <Button type="button" variant="ghost" aria-pressed={mode() === value}
                  onClick={() => { setMode(value); setError(null); }}>
                  {value === "url" ? "From URL" : "Upload audio"}
                </Button>
              )}
            </For>
          </div>
          <Show when={mode() === "url"} fallback={
            <div class="source-field">
              <Label for="file-input">Audio file</Label>
              {/* Providers can omit an audio MIME type; extensions keep those files selectable. */}
              <input id="file-input" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg,.aac,.opus,.webm"
                onChange={(e) => { setFile(e.currentTarget.files?.[0] ?? null); setError(null); }} />
              <Show when={file()}>{(f) => <p class="workspace-helper">Selected: {f().name}</p>}</Show>
            </div>
          }>
            <TextField value={url()} onChange={setUrl} class="source-field">
              <Label for="url-input">Track URL</Label>
              <TextFieldInput id="url-input" type="url" placeholder="https://..." autocomplete="off" />
            </TextField>
          </Show>
        </div>
        <p class="workspace-helper">{mobile() ? "Default: original only, unchanged." : "Download only by default. Your original always stays unchanged."}</p>
        <Show when={analyzing()}>
          <p role="status" aria-live="polite" class="analysis-status">
            <span aria-hidden="true" class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {mode() === "url" ? "Downloading audio and analyzing original key…" : "Analyzing original key…"}
          </p>
        </Show>
        <Show when={analysisError()}>
          <p role="alert" class="text-sm text-destructive">Key analysis: {analysisError()}</p>
        </Show>
      </section>

      <nav class="workspace-tabs" role="tablist" aria-label="Workspace">
        <For each={WORKSPACE_TABS}>{(name, index) => (
          <button type="button" role="tab" id={`tab-${name}`} aria-controls={`page-${name}`}
            aria-selected={tab() === name} tabIndex={tab() === name ? 0 : -1}
            onClick={() => showTab(name)}
            onKeyDown={(event) => {
              let next: WorkspaceTab | undefined;
              if (event.key === "ArrowRight") next = WORKSPACE_TABS[(index() + 1) % 3];
              if (event.key === "ArrowLeft") next = WORKSPACE_TABS[(index() + 2) % 3];
              if (event.key === "Home") next = "outputs";
              if (event.key === "End") next = "review";
              if (next) { event.preventDefault(); showTab(next, true); }
            }}>
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        )}</For>
      </nav>

      <div class="workspace-panes">
        <section class="selection-pane workspace-page" id="page-outputs" data-page="outputs"
          role={mobile() ? "tabpanel" : "region"} aria-label={mobile() ? undefined : "Choose your outputs"}
          aria-labelledby={mobile() ? "tab-outputs" : undefined}>
          <div class="workspace-heading"><h2>Choose your outputs</h2><span>All optional</span></div>
          <div class="option-groups">
            <For each={OPTION_GROUPS}>{(group) => (
              <fieldset class="option-group">
                <legend>{group}</legend>
                <For each={PROCESSING_OPTIONS.filter((option) => option.group === group)}>{(opt) => (
                  <label class="workspace-option" for={`option-${opt.key}`}>
                    <input id={`option-${opt.key}`} type="checkbox" checked={options[opt.key]} aria-label={opt.label}
                      onChange={(event) => setOptions(opt.key, event.currentTarget.checked)} />
                    <span>{mobile() && opt.mobileLabel ? opt.mobileLabel : opt.label}</span>
                  </label>
                )}</For>
              </fieldset>
            )}</For>
          </div>
          <p class="workspace-helper">{mobile() ? "Mixes auto-extract vocals + instruments." : "Mixes automatically extract their required vocal and instrumental parts."}</p>
          <details class="workspace-advanced">
            <summary>Advanced · cache</summary>
            <label class="workspace-option" for="option-no_cache">
              <input id="option-no_cache" type="checkbox" checked={options.no_cache}
                onChange={(event) => setOptions("no_cache", event.currentTarget.checked)} />
              <span>Reprocess from scratch, even if this exact file was separated before</span>
            </label>
          </details>
        </section>

        <aside class="adjustment-rail" aria-label="Adjustments and output preview">
          <section class="workspace-page adjust-page" id="page-adjust" data-page="adjust"
            role={mobile() ? "tabpanel" : "region"} aria-label={mobile() ? undefined : "Fine-tune audio"}
            aria-labelledby={mobile() ? "tab-adjust" : undefined}>
            <h2>Fine-tune &amp; review</h2>
            <div class="workspace-numbers">
              <div>
                <Label for="pitch-input">Pitch shift (semitones)</Label>
                <div class="number-stepper">
                  <Button type="button" variant="outline" size="icon" aria-label="Decrease pitch" aria-controls="pitch-input"
                    disabled={!canAdjust("pitch_semitones", -1)} onClick={() => adjust("pitch_semitones", pitchInput, -1)}>−</Button>
                  <div class="pitch-key-field">
                    <input id="pitch-input" type="number" step="any" ref={pitchInput}
                      aria-describedby={targetKey() ? "pitch-target-key" : undefined}
                      value={DEFAULT_OPTIONS.pitch_semitones}
                      onInput={(event) => setOptions("pitch_semitones", event.currentTarget.valueAsNumber)} />
                    <Show when={targetKey()}>
                      {(key) => <span id="pitch-target-key" class="pitch-key-badge"><span class="sr-only">Resulting key: </span>{key()}</span>}
                    </Show>
                  </div>
                  <Button type="button" variant="outline" size="icon" aria-label="Increase pitch" aria-controls="pitch-input"
                    disabled={!canAdjust("pitch_semitones", 1)} onClick={() => adjust("pitch_semitones", pitchInput, 1)}>+</Button>
                </div>
              </div>
              <div>
                <Label for="tempo-input">Tempo (% of original)</Label>
                <div class="number-stepper">
                  <Button type="button" variant="outline" size="icon" aria-label="Decrease tempo" aria-controls="tempo-input"
                    disabled={!canAdjust("tempo_percent", -1)} onClick={() => adjust("tempo_percent", tempoInput, -1)}>−</Button>
                  <input id="tempo-input" type="number" step="any" ref={tempoInput}
                    value={DEFAULT_OPTIONS.tempo_percent}
                    onInput={(event) => setOptions("tempo_percent", event.currentTarget.valueAsNumber)} />
                  <Button type="button" variant="outline" size="icon" aria-label="Increase tempo" aria-controls="tempo-input"
                    disabled={!canAdjust("tempo_percent", 1)} onClick={() => adjust("tempo_percent", tempoInput, 1)}>+</Button>
                </div>
              </div>
            </div>
            <p class="workspace-helper">Pitch and tempo apply to every generated output, never the original. Changing pitch always includes the full song.</p>
            <div class="workspace-keys" aria-live="polite">
              <div>
                <p class="key-label">Original key</p>
                <Show when={originalKey()} fallback={
                  <p>{analyzed() ? "Original key: Undetermined" : "Awaiting audio"}</p>
                }>
                  <p>Original key: {originalKey()}</p>
                  <KeyNotes musicalKey={originalKey()} />
                </Show>
              </div>
              <div>
                <p class="key-label">Target key</p>
                <Show when={originalKey()} fallback={<p>Awaiting original key</p>}>
                  <p>Target key: {targetKey() ?? "Enter a valid pitch"}</p>
                  <KeyNotes musicalKey={targetKey()} />
                </Show>
              </div>
            </div>
          </section>

          <section class="workspace-page review-page" id="page-review" data-page="review"
            role={mobile() ? "tabpanel" : "region"} aria-label={mobile() ? undefined : "Output preview"}
            aria-labelledby={mobile() ? "tab-review" : undefined}>
            <h2>Output preview</h2>
            <p class="workspace-helper">Tracks and files you'll get ({stems().length + Number(options.extract_lyrics)})</p>
            <div class="output-tags">
              <For each={stems()}>{(label) => <span>{displayOutputLabel(label, options)}</span>}</For>
              <Show when={options.extract_lyrics}><span>Lyrics (timestamped TXT)</span></Show>
            </div>
            <p class="workspace-helper">Your original is included, unchanged.</p>
          </section>

          <div class="workspace-action">
            <div class="action-summary">
              <span>{stems().length + Number(options.extract_lyrics) === 1 ? "Original only · unchanged" : `${stems().length + Number(options.extract_lyrics)} outputs · original included`}</span>
              <button type="button" onClick={() => showTab("review", true)}>Review →</button>
            </div>
            <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
            <Button type="submit" disabled={submitting()} class="workspace-submit">
              {submitting() ? "Submitting..." : expectedStems(options).length > 0 || options.extract_lyrics ? "Process audio" : "Download song"}
            </Button>
          </div>
        </aside>
      </div>
    </form>
  );
};

export default SubmitForm;
