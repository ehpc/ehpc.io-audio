import { createSignal, For, Show, type Component } from "solid-js";
import { createStore } from "solid-js/store";
import type { JobDTO, SeparationOptions } from "~/api";
import { submitJob } from "~/api";
import { Button } from "~/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { Checkbox } from "~/components/checkbox";
import { Label } from "~/components/label";
import { TextField, TextFieldInput } from "~/components/text-field";
import { expectedStems } from "~/lib/expectedStems";

type SourceMode = "url" | "file";

interface OptionDescriptor {
  key: keyof SeparationOptions;
  label: string;
}

const PROCESSING_OPTIONS: OptionDescriptor[] = [
  { key: "decrowd", label: "Remove crowd noise from instrumental" },
  { key: "dereverb", label: "Dereverb (remove reverb)" },
  { key: "genders", label: "Split by gender (male/female)" },
  { key: "lead_backing", label: "Split lead & backing vocals" },
  { key: "drums", label: "Split drums, bass & other instruments" },
];

const DEFAULT_OPTIONS: SeparationOptions = {
  decrowd: false,
  dereverb: false,
  genders: false,
  lead_backing: false,
  drums: false,
  no_cache: false,
};

const SubmitForm: Component<{ onSubmitted: (job: JobDTO) => void }> = (props) => {
  const [mode, setMode] = createSignal<SourceMode>("url");
  const [url, setUrl] = createSignal("");
  const [file, setFile] = createSignal<File | null>(null);
  const [options, setOptions] = createStore<SeparationOptions>({ ...DEFAULT_OPTIONS });
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const trimmedUrl = () => url().trim();
  // The original source is always kept and downloadable, so show it in the
  // preview alongside the separation stems.
  const stems = () => ["original", ...expectedStems(options)];

  const validationError = (): string | null => {
    const hasUrl = mode() === "url" && trimmedUrl().length > 0;
    const hasFile = mode() === "file" && file() !== null;
    if (!hasUrl && !hasFile) {
      return "Provide a URL or choose a file to upload.";
    }
    return null;
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
      setOptions({ ...DEFAULT_OPTIONS });
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New separation</CardTitle>
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
            <legend class="mb-1 text-sm font-medium">Processing options</legend>
            <For each={PROCESSING_OPTIONS}>
              {(opt) => (
                <div class="flex items-center gap-3">
                  <Checkbox
                    checked={options[opt.key]}
                    onChange={(checked) => setOptions(opt.key, checked)}
                  />
                  <Label
                    class="cursor-pointer font-normal"
                    onClick={() => setOptions(opt.key, !options[opt.key])}
                  >
                    {opt.label}
                  </Label>
                </div>
              )}
            </For>
          </fieldset>

          <div class="rounded-md border border-border bg-muted/40 p-3">
            <p class="mb-2 text-xs font-medium text-muted-foreground">
              Tracks you'll get ({stems().length})
            </p>
            <div class="flex flex-wrap gap-1.5">
              <For each={stems()}>
                {(label) => (
                  <span class="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-foreground">
                    {label}
                  </span>
                )}
              </For>
            </div>
          </div>

          <div class="flex items-center gap-3 border-t border-border pt-4">
            <Checkbox
              checked={options.no_cache}
              onChange={(checked) => setOptions("no_cache", checked)}
            />
            <Label
              class="cursor-pointer text-xs font-normal text-muted-foreground"
              onClick={() => setOptions("no_cache", !options.no_cache)}
            >
              Reprocess from scratch, even if this exact file was separated
              before
            </Label>
          </div>

          <Show when={error()}>
            <p class="text-sm text-destructive">{error()}</p>
          </Show>

          <Button type="submit" disabled={submitting()} class="w-full">
            {submitting() ? "Submitting..." : "Start separation"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

export default SubmitForm;
