import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type Component } from "solid-js";
import type { PitchNoteDTO } from "~/api";
import { createPianoOutput, createPianoVoice, setPianoVolume, type PianoVoice } from "~/lib/pianoAudio";
import { noteName } from "~/lib/pitchNotes";
import { pianoLayout, PIANO_BLACK_WIDTH, PIANO_WHITE_WIDTH, type PianoLayout } from "~/lib/pianoLayout";

interface PianoKeyboardProps {
  notes: PitchNoteDTO[];
  rangeNotes: PitchNoteDTO[];
  position: number;
  playing: boolean;
}


const PianoKeyboard: Component<PianoKeyboardProps> = (props) => {
  const [held, setHeld] = createSignal<Set<number>>(new Set());
  const [error, setError] = createSignal("");
  const [volume, setVolume] = createSignal(100);
  const tokens = new Map<string, number>();
  let generation = 0;
  const voices = new Map<number, PianoVoice>();
  const liveVoices = new Set<PianoVoice>();
  let context: AudioContext | undefined;
  let output: GainNode | undefined;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let viewport!: HTMLDivElement;
  const [viewportWidth, setViewportWidth] = createSignal(560);
  let pendingWidth: number | undefined;
  // Preserve the rendered keys and their positions throughout a manual hold,
  // even if the viewport or the song analysis changes before release.
  const layout = createMemo<PianoLayout>(previous => held().size ? previous : pianoLayout(props.rangeNotes, viewportWidth()), pianoLayout(props.rangeNotes, 560));
  createEffect(on([layout, viewportWidth], ([current, width], previous) => {
    if (!viewport || tokens.size || (previous && width === previous[1] && current.left === previous[0].left && current.width === previous[0].width && current.center === previous[0].center)) return;
    viewport.scrollLeft = Math.max(0, current.center - viewport.clientWidth / 2);
  }));
  const active = createMemo(() => {
    if (!props.playing) return null;
    const notes = props.notes;
    let low = 0;
    let high = notes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (notes[middle].start_s <= props.position) low = middle + 1;
      else high = middle;
    }
    const note = notes[low - 1];
    return note && props.position < note.end_s ? Math.round(note.midi) : null;
  });
  createEffect(() => {
    const midi = active();
    if (midi === null || held().size || !viewport) return;
    const current = layout();
    const key = current.keys.find(item => item.midi === midi);
    if (!key) return;
    const left = key.left - current.left;
    const right = left + (key.black ? PIANO_BLACK_WIDTH : PIANO_WHITE_WIDTH);
    if (left < viewport.scrollLeft) viewport.scrollLeft = left;
    else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth;
  });
  const scheduleIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (!tokens.size && context?.state === "running") void context.suspend().catch(() => {});
    }, 200);
  };
  const refreshHeld = () => setHeld(new Set(tokens.values()));
  const release = (token: string) => {
    const midi = tokens.get(token);
    if (midi === undefined) return;
    tokens.delete(token);
    if (![...tokens.values()].includes(midi)) {
      voices.get(midi)?.release();
      voices.delete(midi);
    }
    if (!tokens.size) scheduleIdle();
    if (!tokens.size && pendingWidth !== undefined) { setViewportWidth(pendingWidth); pendingWidth = undefined; }
    refreshHeld();
  };
  const releaseAll = () => {
    generation++;
    tokens.clear();
    for (const voice of voices.values()) voice.release();
    voices.clear();
    scheduleIdle();
    if (pendingWidth !== undefined) { setViewportWidth(pendingWidth); pendingWidth = undefined; }
    refreshHeld();
  };
  const press = (token: string, midi: number) => {
    if (tokens.has(token)) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    tokens.set(token, midi);
    refreshHeld();
    const currentGeneration = generation;
    try {
      if (!context || context.state === "closed") {
        if (!window.AudioContext) throw new Error("Web Audio is not supported in this browser.");
        output?.disconnect();
        output = undefined;
        context = new window.AudioContext();
      }
      const instrument = context;
      const ready = instrument.resume();
      void ready.then(() => {
        if (generation !== currentGeneration || tokens.get(token) !== midi || voices.has(midi)) {
          if (!disposed && !tokens.size) scheduleIdle();
          return;
        }
        if (instrument.state !== "running") throw new Error("Audio could not start.");
        let voice: PianoVoice;
        output ??= createPianoOutput(instrument, volume() / 100);
        voice = createPianoVoice(instrument, midi, output, () => liveVoices.delete(voice));
        liveVoices.add(voice);
        voices.set(midi, voice);
        setError("");
      }).catch(() => { if (generation === currentGeneration && tokens.get(token) === midi) { release(token); setError("Piano audio could not start. Check your browser audio settings."); } });
    } catch (cause) {
      release(token);
      setError(cause instanceof Error ? cause.message : "Piano audio could not start.");
    }
  };
  const visibility = () => { if (document.hidden) releaseAll(); };
  onMount(() => {
    const resize = (width: number) => {
      if (width <= 0) return;
      if (tokens.size) pendingWidth = width;
      else setViewportWidth(width);
    };
    resize(viewport.clientWidth);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(entries => resize(entries[0].contentRect.width));
    observer?.observe(viewport);
    onCleanup(() => observer?.disconnect());
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", visibility);
  });
  onCleanup(() => {
    disposed = true;
    releaseAll();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    for (const voice of liveVoices) voice.dispose();
    output?.disconnect();
    if (context && context.state !== "closed") void context.close().catch(() => {});
    window.removeEventListener("blur", releaseAll);
    document.removeEventListener("visibilitychange", visibility);
  });
  return <section class="piano-keyboard" aria-label="Piano keyboard">
    <p>Play the piano · detected notes light up during playback</p>
    <div class="piano-controls">
    <div class="piano-scroll" ref={viewport}>
      <div class="piano-keys" style={{ width: `${layout().width}px`, "margin-inline": "auto", "--piano-white-width": `${PIANO_WHITE_WIDTH}px`, "--piano-black-width": `${PIANO_BLACK_WIDTH}px` }}>
        <For each={layout().keys}>{key => <button type="button"
          classList={{ "piano-key": true, "piano-key-black": key.black, "piano-key-white": !key.black, "piano-key-active": held().has(key.midi) || active() === key.midi }}
          style={{ left: `${key.left - layout().left}px` }} aria-label={`Piano ${noteName(key.midi)}`}
          aria-pressed={held().has(key.midi) || active() === key.midi}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); press(`p${event.pointerId}`, key.midi); }}
          onPointerUp={event => release(`p${event.pointerId}`)}
          onPointerCancel={event => release(`p${event.pointerId}`)}
          onLostPointerCapture={event => release(`p${event.pointerId}`)}
          on:keydown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!event.repeat) press(`k${key.midi}:${event.key}`, key.midi); } }}
          on:keyup={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); release(`k${key.midi}:${event.key}`); } }}
          onBlur={() => { release(`k${key.midi}: `); release(`k${key.midi}:Enter`); }}
        >{!key.black && noteName(key.midi)}</button>}</For>
      </div>
    </div>
    <label class="piano-volume">
      <input type="range" min="0" max="100" step="1" value={volume()} aria-label="Piano volume"
        aria-valuetext={`${volume()}%`}
        onInput={event => {
          const value = event.currentTarget.valueAsNumber;
          setVolume(value);
          if (output) setPianoVolume(output, value / 100);
        }} />
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M3 9v6h4l5 4V5L7 9H3zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
      </svg>
    </label>
    </div>
    <Show when={error()}><p class="piano-error" role="alert">{error()}</p></Show>
  </section>;
};

export default PianoKeyboard;
