import { Show, type Component } from "solid-js";
import type { JobDTO } from "~/api";
import { lyricsDownloadUrl } from "~/api";

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
        {(text) => <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-sm leading-relaxed">{text()}</pre>}
      </Show>
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
