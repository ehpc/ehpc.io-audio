import { createEffect, For, onCleanup, Show, type Component } from "solid-js";
import type { JobDTO, StemManifestEntry } from "~/api";
import { jobLabel, originalUrl, playbackUrl, resultUrl } from "~/api";
import { displayOutputLabel, manifestOutputLabel } from "~/lib/expectedStems";
import AudioMetadata from "~/components/AudioMetadata";
import { Button } from "~/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import TranscriptView from "~/components/TranscriptView";
import PitchView from "~/components/PitchView";
import PitchedLyricsView from "~/components/PitchedLyricsView";

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

export type HistoryScrollRequest = { jobId: number; token: number };

const ResultsView: Component<{ job: JobDTO; onReset: () => void; scrollRequest?: HistoryScrollRequest | null }> = (props) => {
  const stems = (): StemManifestEntry[] => props.job.manifest ?? [];
  let container!: HTMLDivElement;
  let consumedScrollToken: number | null = null;
  let scheduledScrollToken: number | null = null;
  onCleanup(() => container.querySelectorAll("audio").forEach(audio => audio.pause()));
  createEffect(() => {
    const request = props.scrollRequest;
    const jobId = props.job.id;
    if (!request || request.jobId !== jobId || request.token === consumedScrollToken || request.token === scheduledScrollToken) return;
    scheduledScrollToken = request.token;
    queueMicrotask(() => {
      if (scheduledScrollToken === request.token) scheduledScrollToken = null;
      if (props.scrollRequest?.token !== request.token || props.job.id !== jobId || !container.isConnected) return;
      const karaoke = container.querySelector<HTMLElement>('[aria-label="Karaoke with pitches"]');
      (karaoke ?? container).scrollIntoView({ behavior: "instant", block: "start" });
      consumedScrollToken = request.token;
    });
  });

  return (
    <div ref={container} class="results-panel space-y-6 pb-4">
      <div class="space-y-1">
        <h2 class="break-words text-lg font-semibold [overflow-wrap:anywhere]">{jobLabel(props.job)}</h2>
        <AudioMetadata job={props.job} />
      </div>

      <div class="space-y-4">
        <Show when={props.job.options.detect_pitch && props.job.pitch}>
          <Card>
            <CardContent class="min-w-0 p-4">
              <PitchView job={props.job} />
            </CardContent>
          </Card>
        </Show>
        <Show when={props.job.pitched_lyrics?.length}>
          <Card>
            <CardContent class="min-w-0 p-4">
              <PitchedLyricsView job={props.job} />
            </CardContent>
          </Card>
        </Show>
        <Show when={props.job.options.extract_lyrics && props.job.transcript}>
          <Card>
            <CardContent class="p-4">
              <TranscriptView job={props.job} />
            </CardContent>
          </Card>
        </Show>
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
                src={playbackUrl(originalUrl(props.job.id))}
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
                  <span>{manifestOutputLabel(stem, props.job.options)}</span>
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
                  src={playbackUrl(resultUrl(props.job.id, stem.label))}
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
