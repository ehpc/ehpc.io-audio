import { For, Show, createEffect, createMemo } from "solid-js";
import type { JobDTO } from "~/api";
import { currentKaraokeLine, karaokeLines, karaokeWordState } from "~/lib/karaoke";

interface TimelineKaraokeProps {
  job: JobDTO;
  /** Output-clock seconds supplied by the timeline's single media clock. */
  position: number;
}

export default function TimelineKaraoke(props: TimelineKaraokeProps) {
  const lines = createMemo(() => karaokeLines(props.job));
  const current = createMemo(() => currentKaraokeLine(lines(), props.position));
  const hasTiming = createMemo(() => lines().some(line => line.timing !== null));
  let reader: HTMLElement | undefined;
  createEffect(() => {
    current();
    if (reader) reader.scrollTop = 0;
  });

  return (
    <section ref={reader} class="timeline-karaoke" tabIndex={0} aria-label="Current karaoke line" aria-live="off">
      <Show when={current()} keyed fallback={
        <p class="timeline-karaoke-line timeline-karaoke-hint">
          {hasTiming() ? "Lyrics begin shortly" : "No reliably timed lyrics available"}
        </p>
      }>
        {line => (
          <p class="timeline-karaoke-line">
            <For each={line.parts}>{part => {
              if (typeof part === "string") return part;
              const state = createMemo(() => karaokeWordState(part.timing, props.position));
              return (
                <span class="timeline-karaoke-word"
                  data-state={state().state}
                  aria-current={state().state === "active" ? "true" : undefined}
                  style={{ "--karaoke-progress": `${state().progress * 100}%` }}
                >{part.text}</span>
              );
            }}</For>
          </p>
        )}
      </Show>
    </section>
  );
}
