import { For, Show, type Component } from "solid-js";
import type { JobDTO, StemManifestEntry } from "~/api";
import { downloadName, jobLabel, originalUrl, resultUrl } from "~/api";
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
      </div>

      <div class="space-y-4">
        <Show when={props.job.has_original}>
          <Card>
            <CardHeader>
              <CardTitle class="text-base capitalize">original</CardTitle>
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
                  <span class="capitalize">{stem.label}</span>
                  <span class="text-xs font-normal text-muted-foreground">
                    {formatDuration(stem.duration_s)} · {formatSize(stem.size_bytes)}
                  </span>
                </CardTitle>
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
                  download={downloadName(props.job, stem.label)}
                  class="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Download {downloadName(props.job, stem.label)}
                </a>
              </CardContent>
            </Card>
          )}
        </For>
      </div>

      <Button variant="outline" onClick={props.onReset}>
        Start another separation
      </Button>
    </div>
  );
};

export default ResultsView;
