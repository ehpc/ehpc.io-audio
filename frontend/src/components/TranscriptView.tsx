import { For, Show, type Component } from "solid-js";
import type { JobDTO } from "~/api";
import { lyricsDownloadUrl, lyricsJsonDownloadUrl } from "~/api";

const TranscriptView: Component<{ job: JobDTO; compact?: boolean }> = (props) => {
  const transcript = () => props.job.transcript;
  const content = () => (
    <>
      <p class="text-xs text-muted-foreground">Original audio timestamps · approximate segment timing. Automatic transcription may contain errors; review the text.</p>
      <Show when={transcript()?.language}>
        {(language) => <p class="text-xs text-muted-foreground">Language: {language()}</p>}
      </Show>
      <Show when={(transcript()?.sections.length ?? 0) > 0}>
        <p class="text-xs text-muted-foreground">Musical section labels are automatic estimates and may be inaccurate.</p>
      </Show>
      <Show when={transcript()?.status === "empty"}>
        <p class="text-sm text-muted-foreground">No speech was recognized.</p>
      </Show>
      <Show when={transcript()?.timestamped_text}>
        {(text) => <pre aria-label="Timestamped lyrics" class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-sm leading-relaxed">{text()}</pre>}
      </Show>
      <Show when={transcript()?.reference}>{review => (
        <div class="space-y-2 rounded-md border border-border p-3" aria-label="Lyrics reference comparison">
          <p class="text-sm font-medium">Online lyrics comparison: {review().status}</p>
          <p class="text-xs text-muted-foreground">{review().reason}</p>
          <Show when={review().source_url}>{url => (
            <a href={url()} target="_blank" rel="noopener noreferrer" class="text-sm text-primary underline">
              {review().provider} source: {review().artist} — {review().title}
            </a>
          )}</Show>
          <Show when={review().agreement !== null}>
            <p class="text-xs text-muted-foreground">Ordered full-text agreement: {Math.round((review().agreement ?? 0) * 100)}%.</p>
          </Show>
          <Show when={review().corrections.length > 0}>
            <p class="text-xs text-muted-foreground">Tentative spelling corrections, not verified lyrics. All ASR timings are retained; no reference timing or syllables are imported.</p>
            <ul class="list-inside list-disc text-sm">
              <For each={review().corrections}>{correction => (
                <li>“{correction.original}” → “{correction.replacement}” ({correction.start_s.toFixed(2)}s on original audio)</li>
              )}</For>
            </ul>
          </Show>
          <details>
            <summary class="flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">Original ASR (before reference comparison)</summary>
            <pre aria-label="Original ASR text" class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-sm">{transcript()?.original_timestamped_text || "No words recognized."}</pre>
          </details>
          <a href={lyricsJsonDownloadUrl(props.job.id)} download="" class="text-sm font-medium text-primary hover:underline">Download lyrics JSON + original ASR</a>
        </div>
      )}</Show>
    </>
  );
  return (
    <section
      class={props.compact ? "space-y-2 border-t border-border pt-3" : "space-y-3"}
      aria-label="Lyrics transcript"
      onClick={(event) => { if (props.compact) event.stopPropagation(); }}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base font-semibold">Lyrics</h3>
        <a
          href={lyricsDownloadUrl(props.job.id)}
          download=""
          class="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Download timestamped TXT
        </a>
      </div>
      <Show when={props.compact}>
        <details>
          <summary class="flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">View lyrics</summary>
          <div class="space-y-2">{content()}</div>
        </details>
      </Show>
      <Show when={!props.compact}>
        {content()}
      </Show>
    </section>
  );
};

export default TranscriptView;
