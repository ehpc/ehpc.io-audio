import { For, Show, type Component } from "solid-js";
import type { JobDTO, StemManifestEntry } from "~/api";
import { jobLabel, originalUrl, resultUrl } from "~/api";
import { displayOutputLabel } from "~/lib/expectedStems";
import AudioMetadata from "~/components/AudioMetadata";
import { Button } from "~/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const ResultsView: Component<{ job: JobDTO; onReset: () => void }> = (props) => {
  const stems = (): StemManifestEntry[] => props.job.manifest ?? [];

  return (
    <div class="space-y-6">
      <div class="space-y-1">
        <h2 class="text-lg font-semibold">Results</h2>
        <p class="text-sm text-muted-foreground">{jobLabel(props.job)}</p>
        <AudioMetadata job={props.job} />
      </div>

      <div class="space-y-4">
        <Show when={props.job.has_original}>
          <Card>
            <CardHeader>
              <CardTitle class="text-base">{displayOutputLabel("original", props.job.options)}</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3">
              <audio
                controls
                preload="none"
                class="w-full"
                src={originalUrl(props.job.id)}
              />
              <a
                href={originalUrl(props.job.id)}
                download=""
                class="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Download original
              </a>
            </CardContent>
          </Card>
        </Show>

        <For each={stems()}>
          {(stem) => (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center justify-between gap-4 text-base">
                  <span>{displayOutputLabel(stem.label, props.job.options)}</span>
                  <span class="text-xs font-normal text-muted-foreground">
                    {formatDuration(stem.duration_s)} · {formatSize(stem.size_bytes)}
                  </span>
                </CardTitle>
                <Show when={props.job.original_key}>
                  <p class="text-sm text-muted-foreground">Source key: {props.job.original_key}</p>
                </Show>
              </CardHeader>
              <CardContent class="space-y-3">
                <audio
                  controls
                  preload="none"
                  class="w-full"
                  src={resultUrl(props.job.id, stem.label)}
                />
                <a
                  href={resultUrl(props.job.id, stem.label)}
                  download={stem.download_name}
                  class="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Download {stem.download_name}
                </a>
              </CardContent>
            </Card>
          )}
        </For>
      </div>

      <Button variant="outline" onClick={props.onReset}>
        Start another job
      </Button>
    </div>
  );
};

export default ResultsView;
