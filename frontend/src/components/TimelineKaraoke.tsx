import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JobDTO, PitchNoteDTO } from "~/api";
import { currentKaraokeLine, karaokeLines, karaokeWordState, type KaraokeLine, type KaraokePart, type KaraokeWord } from "~/lib/karaoke";
import { Button } from "~/components/button";

// Percent of the normal reader size; shared by inline and fullscreen views.
export const LYRIC_FONT = { default: 200, min: 75, max: 400, step: 25 } as const;

interface TimelineKaraokeProps {
  job: JobDTO;
  /** Output-clock seconds supplied by the timeline's single media clock. */
  position: number;
  notes?: PitchNoteDTO[];
  playing?: boolean;
  seeking?: boolean;
  seekRevision?: number;
  onKeyDown?: (event: KeyboardEvent) => void;
  fontSize?: number;
  onFontSize?: (size: number) => void;
  showPitches?: boolean;
  onShowPitches?: (show: boolean) => void;
  onFullscreen?: (trigger: HTMLButtonElement) => void;
  fit?: boolean;
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
  const [localPitches, setLocalPitches] = createSignal(true);
  const showPitches = () => props.showPitches ?? localPitches();
  const togglePitches = () => props.onShowPitches ? props.onShowPitches(!showPitches()) : setLocalPitches(!showPitches());
  const [sliding, setSliding] = createSignal(false);
  const hasTiming = createMemo(() => lines().some(line => line.timing !== null));
  let reader: HTMLElement | undefined;
  let fitFrame: number | undefined;
  let disposed = false;
  const scheduleFit = () => {
    if (!props.fit || disposed) return;
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined;
      if (!reader || !reader.clientWidth || !reader.clientHeight) return;
      const rows = [...reader.querySelectorAll<HTMLElement>(".timeline-karaoke-line")];
      const padding = getComputedStyle(reader);
      const height = reader.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
      const fits = (size: number) => {
        reader!.style.fontSize = `${size}px`;
        let totalHeight = 0;
        for (const row of rows) {
          const range = document.createRange();
          range.selectNodeContents(row);
          if (range.getBoundingClientRect().width > row.clientWidth) return false;
          totalHeight += row.getBoundingClientRect().height;
        }
        return totalHeight <= height;
      };
      let low = 0, high = height;
      for (let i = 0; i < 14; i++) {
        const middle = (low + high) / 2;
        if (fits(middle)) low = middle; else high = middle;
      }
      const preference = Math.min(1, (props.fontSize ?? LYRIC_FONT.default) / LYRIC_FONT.default);
      reader.style.fontSize = `${low * preference}px`;
    });
  };
  onMount(() => {
    if (!props.fit) return;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleFit);
    if (reader) observer?.observe(reader);
    window.addEventListener("resize", scheduleFit);
    document.fonts?.ready.then(scheduleFit);
    document.fonts?.addEventListener("loadingdone", scheduleFit);
    scheduleFit();
    onCleanup(() => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleFit);
      document.fonts?.removeEventListener("loadingdone", scheduleFit);
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
    });
  });
  createEffect(() => {
    current(); next(); showPitches(); props.notes; props.fontSize;
    scheduleFit();
  });
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
      <Button type="button" variant={showPitches() ? "secondary" : "outline"} aria-pressed={showPitches()} onClick={togglePitches}>Pitches</Button>
      <Show when={props.onFontSize}>
        <Button type="button" variant="outline" aria-label="Smaller lyrics" disabled={(props.fontSize ?? LYRIC_FONT.default) <= LYRIC_FONT.min} onClick={() => props.onFontSize?.(Math.max(LYRIC_FONT.min, Math.min(props.fit ? LYRIC_FONT.default : LYRIC_FONT.max, props.fontSize ?? LYRIC_FONT.default) - LYRIC_FONT.step))}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 19 9 4l6 15M5 14h8M16 12h6" /></svg>
        </Button>
        <Button type="button" variant="outline" aria-label="Larger lyrics" disabled={(props.fontSize ?? LYRIC_FONT.default) >= (props.fit ? LYRIC_FONT.default : LYRIC_FONT.max)} onClick={() => props.onFontSize?.(Math.min(props.fit ? LYRIC_FONT.default : LYRIC_FONT.max, (props.fontSize ?? LYRIC_FONT.default) + LYRIC_FONT.step))}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 19 9 4l6 15M5 14h8M16 12h6M19 9v6" /></svg>
        </Button>
      </Show>
      <Show when={props.onFullscreen}>
        <Button type="button" variant="outline" aria-label="Open karaoke fullscreen" onClick={event => props.onFullscreen?.(event.currentTarget)}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>
        </Button>
      </Show>
    </div>
    <section ref={reader} class="timeline-karaoke" tabIndex={0} aria-label="Current karaoke line" aria-live="off" style={{ "--karaoke-scale": (props.fontSize ?? LYRIC_FONT.default) / 100 }}
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
