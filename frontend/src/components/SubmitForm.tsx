import { createEffect, createSignal, For, onCleanup, Show, type Component } from "solid-js";
import { createStore } from "solid-js/store";
import type { BooleanOptionKey, JobDTO, SeparationOptions } from "~/api";
import { analyzeKey, audioSettingsError, submitJob } from "~/api";
import { Button } from "~/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { Checkbox } from "~/components/checkbox";
import KeyNotes from "~/components/KeyNotes";
import { Label } from "~/components/label";
import { TextField, TextFieldInput } from "~/components/text-field";
import { displayOutputLabel, expectedStems } from "~/lib/expectedStems";
import { transposeKey } from "~/lib/music";

type SourceMode = "url" | "file";

interface OptionDescriptor {
  key: BooleanOptionKey;
  label: string;
}

const PROCESSING_OPTIONS: OptionDescriptor[] = [
  { key: "extract_vocals", label: "Extract vocals" },
  { key: "extract_instruments", label: "Extract instruments" },
  { key: "mix_female_instruments", label: "Female vocals + instruments" },
  { key: "mix_male_instruments", label: "Male vocals + instruments" },
  { key: "mix_backing_instruments", label: "Backing vocals + instruments" },
  { key: "decrowd", label: "Remove crowd noise from instrumental" },
  { key: "decrowd_vocals", label: "Remove crowd noise from vocals" },
  { key: "dereverb", label: "Dereverb (remove reverb)" },
  { key: "genders", label: "Split by gender (male/female)" },
  { key: "lead_backing", label: "Split lead & backing vocals" },
  { key: "drums", label: "Split drums, bass & other instruments" },
];

const DEFAULT_OPTIONS: SeparationOptions = {
  extract_vocals: false,
  extract_instruments: false,
  mix_female_instruments: false,
  mix_male_instruments: false,
  mix_backing_instruments: false,
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
  let fileInput: HTMLInputElement | undefined;

  const trimmedUrl = () => url().trim();
  // The original source is always kept and downloadable.
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
    const chosenFile = file();
    try {
      const result = await submitJob({
        url: usingUrl ? trimmedUrl() : undefined,
        file: usingUrl ? undefined : chosenFile ?? undefined,
        options: { ...options },
      });
      props.onSubmitted({
        id: result.id,
        status: result.status,
        position: result.position,
        source_type: usingUrl ? "url" : "upload",
        source_value: usingUrl ? trimmedUrl() : chosenFile!.name,
        // A URL's title is resolved server-side after download; an upload's
        // filename is its title.
        title: usingUrl ? null : chosenFile!.name,
        original_key: null,
        output_key: null,
        options: { ...options },
        manifest: null,
        error_message: null,
        created_at: Math.floor(Date.now() / 1000),
        has_original: false,
      });
      // The form stays mounted permanently (never swapped away), so reset it
      // for the next submission instead of relying on a remount to do so.
      setUrl("");
      setFile(null);
      if (fileInput) fileInput.value = "";
      setOptions({ ...DEFAULT_OPTIONS });
      pitchInput.value = String(DEFAULT_OPTIONS.pitch_semitones);
      tempoInput.value = String(DEFAULT_OPTIONS.tempo_percent);
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Download or process a song</CardTitle>
      </CardHeader>
      <CardContent>
        <form class="space-y-6" onSubmit={handleSubmit}>
          <div class="inline-flex rounded-md border border-input p-1">
            <For each={["url", "file"] as SourceMode[]}>
              {(value) => (
                <Button
                  type="button"
                  variant={mode() === value ? "default" : "ghost"}
                  size="sm"
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                >
                  {value === "url" ? "From URL" : "Upload audio"}
                </Button>
              )}
            </For>
          </div>

          <Show
            when={mode() === "url"}
            fallback={
              <div class="space-y-2">
                <Label for="file-input">Audio file</Label>
                <input
                  id="file-input"
                  type="file"
                  accept="audio/*"
                  ref={fileInput}
                  class="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:opacity-90"
                  onChange={(e) => {
                    setFile(e.currentTarget.files?.[0] ?? null);
                    setError(null);
                  }}
                />
                <Show when={file()}>
                  {(f) => (
                    <p class="text-xs text-muted-foreground">Selected: {f().name}</p>
                  )}
                </Show>
              </div>
            }
          >
            <TextField value={url()} onChange={setUrl}>
              <Label for="url-input">Track URL</Label>
              <TextFieldInput
                id="url-input"
                type="url"
                placeholder="https://..."
                autocomplete="off"
              />
            </TextField>
          </Show>

          <fieldset class="space-y-3">
            <legend class="mb-1 text-sm font-medium">Processing options (optional)</legend>
            <For each={PROCESSING_OPTIONS}>
              {(opt) => (
                <div class="flex items-center gap-3">
                  <Checkbox id={`option-${opt.key}`} checked={options[opt.key]} onChange={(checked) => setOptions(opt.key, checked)} />
                  <Label for={`option-${opt.key}-input`} class="cursor-pointer font-normal">{opt.label}</Label>
                </div>
              )}
            </For>
          </fieldset>
            <p class="text-xs text-muted-foreground">Mixes automatically extract their required vocal and instrumental parts.</p>

          <fieldset class="space-y-3">
            <legend class="mb-1 text-sm font-medium">Pitch and tempo</legend>
            <Show when={analyzing()}>
              <p role="status" aria-live="polite" class="flex items-center gap-2 text-sm text-muted-foreground">
                <span aria-hidden="true" class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {mode() === "url" ? "Downloading audio and analyzing original key…" : "Analyzing original key…"}
              </p>
            </Show>
            <Show when={analysisError()}>
              <p role="alert" class="text-sm text-destructive">Key analysis: {analysisError()}</p>
            </Show>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-2">
                <Label for="pitch-input">Pitch shift (semitones)</Label>
                <input
                  id="pitch-input"
                  type="number"
                  step="any"
                  ref={pitchInput}
                  value={DEFAULT_OPTIONS.pitch_semitones}
                  onInput={(event) => setOptions("pitch_semitones", event.currentTarget.valueAsNumber)}
                  class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <Show when={originalKey()}>
                  <div class="grid gap-2 text-sm sm:grid-cols-2" aria-live="polite">
                    <div>
                      <p>Original key: {originalKey()}</p>
                      <KeyNotes musicalKey={originalKey()} />
                    </div>
                    <div>
                      <p>Target key: {targetKey() ?? "Enter a valid pitch"}</p>
                      <KeyNotes musicalKey={targetKey()} />
                    </div>
                  </div>
                </Show>
                <Show when={analyzed() && originalKey() === null}>
                  <p class="text-xs text-muted-foreground">Original key: Undetermined</p>
                </Show>
              </div>
              <div class="space-y-2">
                <Label for="tempo-input">Tempo (% of original)</Label>
                <input
                  id="tempo-input"
                  type="number"
                  step="any"
                  ref={tempoInput}
                  value={DEFAULT_OPTIONS.tempo_percent}
                  onInput={(event) => setOptions("tempo_percent", event.currentTarget.valueAsNumber)}
                  class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              Pitch and tempo apply to every output. With no separation option, they transform the full song; the original remains unchanged.
            </p>
          </fieldset>

          <div class="rounded-md border border-border bg-muted/40 p-3">
            <p class="mb-2 text-xs font-medium text-muted-foreground">
              Tracks you'll get ({stems().length})
            </p>
            <div class="flex flex-wrap gap-1.5">
              <For each={stems()}>
                {(label) => (
                  <span class="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-foreground">
                    {displayOutputLabel(label, options)}
                  </span>
                )}
              </For>
            </div>
          </div>

          <div class="flex items-center gap-3 border-t border-border pt-4">
            <Checkbox
              id="option-no_cache"
              checked={options.no_cache}
              onChange={(checked) => setOptions("no_cache", checked)}
            />
            <Label
              for="option-no_cache-input"
              class="cursor-pointer text-xs font-normal text-muted-foreground"
            >
              Reprocess from scratch, even if this exact file was separated
              before
            </Label>
          </div>

          <Show when={error()}>
            <p class="text-sm text-destructive">{error()}</p>
          </Show>

          <Button type="submit" disabled={submitting()} class="w-full">
            {submitting() ? "Submitting..." : expectedStems(options).length > 0 ? "Process audio" : "Download song"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

export default SubmitForm;
