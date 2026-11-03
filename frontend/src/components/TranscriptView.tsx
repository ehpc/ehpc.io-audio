import { For, Show, type Component } from "solid-js";
import type { JobDTO } from "~/api";
import { lyricsDownloadUrl, lyricsJsonDownloadUrl } from "~/api";

const TranscriptView: Component<{ job: JobDTO; compact?: boolean }> = (props) => {
  const transcript = () => props.job.transcript;
  const content = () => (
    <>
      <p class="text-xs text-muted-foreground">Original audio timestamps · approximate segment timing. Automatic transcription may contain errors; review the text.</p>
      <Show when={transcript()?.asr_model === "Qwen/Qwen3-ASR-1.7B"}>
        <p class="text-xs text-muted-foreground">Reference-first lyrics · unprompted Qwen singing recognition + multilingual MMS acoustic alignment. Reference-aligned text is not verified lyrics. Unconfirmed text has no word timestamps; acoustic scores are not calibrated correctness probabilities.</p>
      </Show>
      <Show when={!transcript()?.asr_model}>
        <p class="text-xs text-muted-foreground">Recognition model unspecified in this stored result; model provenance cannot be recovered.</p>
      </Show>
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
          <p class="text-sm font-medium">Online lyrics {review().lines?.length ? "alignment" : "comparison"}: {review().status}</p>
          <p class="text-xs text-muted-foreground">{review().reason}</p>
          <Show when={review().source_url}>{url => (
            <a href={url()} target="_blank" rel="noopener noreferrer" class="text-sm text-primary underline">
              {review().provider} source: {review().artist} — {review().title}
            </a>
          )}</Show>
          <Show when={review().agreement !== null}>
            <p class="text-xs text-muted-foreground">Ordered full-text agreement: {Math.round((review().agreement ?? 0) * 100)}%.</p>
          </Show>
          <Show when={review().fetched_at}>
            <p class="text-xs text-muted-foreground">{review().cached ? "Cached successful provider record" : "Provider record fetched"}: {review().fetched_at}.</p>
          </Show>
          <Show when={review().provider_timing_status && review().provider_timing_status !== "absent"}>
            <p class="text-xs text-muted-foreground">Provider line-timing priors: {review().provider_timing_status}. {review().provider_timing_reason}</p>
          </Show>
          <Show when={(review().lines?.length ?? 0) > 0}>
            <details>
              <summary class="flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">Canonical reference order and audio support</summary>
              <p class="text-xs text-muted-foreground">Local agreement selects candidates, not proof of every word. Independent recognized variants/adlibs remain in provenance; only acoustically reconciled reference text replaces them. Provider line priors are not measured word times.</p>
              <ol class="list-inside list-decimal space-y-2 text-sm">
                <For each={review().lines}>{line => (
                  <li class="rounded border border-border p-2">
                    <span>{line.text}</span>
                    <p class="text-xs text-muted-foreground">
                      {line.status === "aligned" ? `Reference-aligned · ${line.start_s?.toFixed(2)}–${line.end_s?.toFixed(2)}s (original clock)` : "??:??"}
                      {` · ${Math.round(line.support * 100)}% local word agreement`}
                    </p>
                    <Show when={line.unconfirmed_words.length > 0}>
                      <p class="text-xs text-muted-foreground">Not independently corroborated; no word timestamps: {line.unconfirmed_words.join(", ")}.</p>
                    </Show>
                    <Show when={line.recognized_variant}>
                      <p class="text-xs text-muted-foreground">Independent recognition variant (preserved): {line.recognized_variant}.</p>
                    </Show>
                    <Show when={line.provider_start_s != null && line.provider_end_s != null}>
                      <p class="text-xs text-muted-foreground">Provider search prior: {line.provider_start_s?.toFixed(2)}–{line.provider_end_s?.toFixed(2)}s · NOT word timestamps.</p>
                    </Show>
                    <Show when={line.acoustic_log_odds != null}>
                      <p class="text-xs text-muted-foreground">Same-frame acoustic comparison: {line.canonical_log_score?.toFixed(4)} vs {line.alternative_log_score?.toFixed(4)} log likelihood per source frame; log ratio {line.acoustic_log_odds?.toFixed(2)}. Compared variant: {line.acoustic_alternative}. These scores are not correctness probabilities.</p>
                    </Show>
                    <p class="text-xs text-muted-foreground">{line.reason}</p>
                  </li>
                )}</For>
              </ol>
            </details>
          </Show>
          <Show when={review().corrections.length > 0}>
            <p class="text-xs text-muted-foreground">Historical tentative spelling corrections from an earlier job, not verified lyrics. Original ASR evidence and timings are preserved.</p>
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
      <Show when={(transcript()?.recognition_chunks?.length ?? 0) > 0}>
        <details>
          <summary class="flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">Raw independent recognition (input windows, not lyric timestamps)</summary>
          <p class="text-xs text-muted-foreground">Unprompted model text is retained even when alignment fails. Padded input windows can overlap; their bounds are not sung-word onset/offset estimates.</p>
          <For each={transcript()?.recognition_chunks}>{chunk => (
            <div class="rounded border border-border p-2 text-sm">
              <p class="text-xs text-muted-foreground">Input {chunk.input_start_s.toFixed(2)}–{chunk.input_end_s.toFixed(2)}s · ownership {chunk.ownership_start_s.toFixed(2)}–{chunk.ownership_end_s.toFixed(2)}s · {chunk.language || "No language detected"}</p>
              <p class="whitespace-pre-wrap break-words">{chunk.text || "No text recognized."}</p>
            </div>
          )}</For>
        </details>
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
