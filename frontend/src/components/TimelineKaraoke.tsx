import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JobDTO, PitchNoteDTO } from "~/api";
import { currentKaraokeLine, karaokeLines, karaokeWordState, type KaraokeLine, type KaraokePart, type KaraokeWord } from "~/lib/karaoke";
import { Button } from "~/components/button";

interface TimelineKaraokeProps {
  job: JobDTO;
  /** Output-clock seconds supplied by the timeline's single media clock. */
  position: number;
  notes?: PitchNoteDTO[];
  playing?: boolean;
  seeking?: boolean;
  seekRevision?: number;
  onKeyDown?: (event: KeyboardEvent) => void;
}

interface DisplayWord {
  word: KaraokeWord;
  suffix: string;
}

// Keep directly adjacent punctuation beside its word, rather than at the
// far edge of a cell widened by a long note sequence.
function displayParts(parts: KaraokePart[]): (string | DisplayWord)[] {
  const result: (string | DisplayWord)[] = [];
  for (const part of parts) {
    if (typeof part !== "string") {
      result.push({ word: part, suffix: "" });
      continue;
    }
    const previous = result.at(-1);
    const suffix = typeof previous === "object" ? /^\S+/u.exec(part)?.[0] ?? "" : "";
    if (suffix && typeof previous === "object") previous.suffix = suffix;
    if (part.length > suffix.length) result.push(part.slice(suffix.length));
  }
  return result;
}

export default function TimelineKaraoke(props: TimelineKaraokeProps) {
  const lines = createMemo(() => karaokeLines(props.job));
  const current = createMemo(() => currentKaraokeLine(lines(), props.position));
  const next = createMemo(() => {
    const all = lines();
    const index = all.indexOf(current()!);
    return index < 0 ? null : all.slice(index + 1).find(line => line.timing !== null) ?? null;
  });
  const visibleLines = createMemo(() => [current(), next()].filter((line): line is KaraokeLine => line !== null));
  const pitches = createMemo(() => {
    const result = new Map<number, string[]>();
    for (const note of props.notes ?? []) {
      for (const index of note.word_indices) {
        const labels = result.get(index) ?? [];
        labels.push(note.note);
        result.set(index, labels);
      }
    }
    return result;
  });
  const [showPitches, setShowPitches] = createSignal(true);
  const [sliding, setSliding] = createSignal(false);
  const hasTiming = createMemo(() => lines().some(line => line.timing !== null));
  let reader: HTMLElement | undefined;
  let previous: KaraokeLine | null = null;
  let previousNext: KaraokeLine | null = null;
  let previousPosition = props.position;
  let previousSeek = props.seekRevision ?? 0;
  createEffect(() => {
    const position = props.position;
    const seek = props.seekRevision ?? 0;
    const line = current();
    const following = next();
    if (line !== previous || seek !== previousSeek) {
      setSliding(Boolean(props.playing && !props.seeking && line && line === previousNext && seek === previousSeek
        && position >= previousPosition && position - previousPosition < 1));
      if (reader) reader.scrollTop = 0;
    }
    previous = line;
    previousNext = following;
    previousPosition = position;
    previousSeek = seek;
  });

  return <>
    <div class="timeline-karaoke-controls">
      <Button type="button" variant={showPitches() ? "secondary" : "outline"} aria-pressed={showPitches()} onClick={() => setShowPitches(!showPitches())}>Pitches</Button>
    </div>
    <section ref={reader} class="timeline-karaoke" tabIndex={0} aria-label="Current karaoke line" aria-live="off"
      onClick={event => {
        if (!(event.target instanceof Element) || !event.target.closest(".timeline-karaoke-pitches")) reader?.focus({ preventScroll: true });
      }} onKeyDown={event => props.onKeyDown?.(event)}>
      <Show when={current()} fallback={
        <p class="timeline-karaoke-line timeline-karaoke-hint">
          {hasTiming() ? "Lyrics begin shortly" : "No reliably timed lyrics available"}
        </p>
      }>
        <For each={visibleLines()}>{line =>
          <p class="timeline-karaoke-line" classList={{ "timeline-karaoke-next": line !== current(), "timeline-karaoke-slide": line === current() && sliding() }}
            role="group" aria-label={line === current() ? "Current lyrics" : "Next lyrics"} tabIndex={line === current() ? undefined : 0}>
            <For each={displayParts(line.parts)}>{part => {
              if (typeof part === "string") return part;
              const state = createMemo(() => karaokeWordState(part.word.timing, props.position));
              const labels = () => part.word.pitchIndex === undefined ? undefined : pitches().get(part.word.pitchIndex);
              return <span class="timeline-karaoke-cell">
                <Show when={showPitches() && labels()?.length}>
                  <span class="timeline-karaoke-pitches" role="group" tabIndex={0}
                    aria-label={`Pitches for ${part.word.text}: ${labels()!.join(" ")}`}>{labels()!.join(" ")}</span>
                </Show>
                <span class="timeline-karaoke-lyric"><span class="timeline-karaoke-word"
                  data-state={state().state}
                  aria-current={line === current() && state().state === "active" ? "true" : undefined}
                  style={{ "--karaoke-progress": `${state().progress * 100}%` }}
                >{part.word.text}</span>{part.suffix}</span>
              </span>;
            }}</For>
          </p>
        }</For>
      </Show>
    </section>
  </>;
}
