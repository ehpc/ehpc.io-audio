import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import type { PitchNoteDTO } from "~/api";
import { createPianoVoice, type PianoVoice } from "~/lib/pianoAudio";
import { noteName } from "~/lib/pitchNotes";

interface PianoKeyboardProps {
  notes: PitchNoteDTO[];
  position: number;
  playing: boolean;
}

const blackPitchClasses = new Set([1, 3, 6, 8, 10]);

const PianoKeyboard: Component<PianoKeyboardProps> = (props) => {
  const [held, setHeld] = createSignal<Set<number>>(new Set());
  const [error, setError] = createSignal("");
  const tokens = new Map<string, number>();
  let generation = 0;
  const voices = new Map<number, PianoVoice>();
  const liveVoices = new Set<PianoVoice>();
  let context: AudioContext | undefined;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let viewport!: HTMLDivElement;
  const keys = createMemo(() => {
    let low = 127;
    let high = 0;
    let found = false;
    for (const note of props.notes) {
      const midi = Math.round(note.midi);
      if (!Number.isFinite(midi) || midi < 0 || midi > 127) continue;
      found = true;
      low = Math.min(low, midi);
      high = Math.max(high, midi);
    }
    const first = found ? Math.min(108, Math.floor(low / 12) * 12) : 60;
    const last = found ? Math.min(127, Math.max(first + 23, Math.floor(high / 12) * 12 + 11)) : 83;
    let white = 0;
    return Array.from({ length: last - first + 1 }, (_, i) => {
      const midi = first + i;
      const black = blackPitchClasses.has(midi % 12);
      const left = black ? white * 40 - 13 : white++ * 40;
      return { midi, black, left };
    });
  });
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
    const key = keys().find(item => item.midi === midi);
    if (!key) return;
    const right = key.left + (key.black ? 26 : 40);
    if (key.left < viewport.scrollLeft) viewport.scrollLeft = key.left;
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
    refreshHeld();
  };
  const releaseAll = () => {
    generation++;
    tokens.clear();
    for (const voice of voices.values()) voice.release();
    voices.clear();
    scheduleIdle();
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
        voice = createPianoVoice(instrument, midi, instrument.destination, () => liveVoices.delete(voice));
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
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", visibility);
  });
  onCleanup(() => {
    disposed = true;
    releaseAll();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    for (const voice of liveVoices) voice.dispose();
    if (context && context.state !== "closed") void context.close().catch(() => {});
    window.removeEventListener("blur", releaseAll);
    document.removeEventListener("visibilitychange", visibility);
  });
  return <section class="piano-keyboard" aria-label="Piano keyboard">
    <p>Play the piano · detected notes light up during playback</p>
    <div class="piano-scroll" ref={viewport}>
      <div class="piano-keys" style={{ width: `${keys().filter(key => !key.black).length * 40}px` }}>
        <For each={keys()}>{key => <button type="button"
          classList={{ "piano-key": true, "piano-key-black": key.black, "piano-key-white": !key.black, "piano-key-active": held().has(key.midi) || active() === key.midi }}
          style={{ left: `${key.left}px` }} aria-label={`Piano ${noteName(key.midi)}`}
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
    <Show when={error()}><p class="piano-error" role="alert">{error()}</p></Show>
  </section>;
};

export default PianoKeyboard;
