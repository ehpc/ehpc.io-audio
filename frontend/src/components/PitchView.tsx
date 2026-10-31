import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js";
import type { JobDTO, PitchNoteDTO } from "~/api";
import { originalUrl, pitchDownloadUrl, resultUrl } from "~/api";
import { displayOutputLabel } from "~/lib/expectedStems";
import { Button } from "~/components/button";

const ROW_HEIGHT = 24;
const AXIS_WIDTH = 54;
const MIN_ZOOM = 40;
const MAX_ZOOM = 640;
const ZOOM_STEP = 20;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
function timeLabel(seconds: number): string {
  const centiseconds = Math.round(seconds * 100);
  const minutes = Math.floor(centiseconds / 6000);
  return `${minutes}:${((centiseconds % 6000) / 100).toFixed(2).padStart(5, "0")}`;
}

interface TimeTick {
  seconds: number;
  label: string;
}

const PitchView: Component<{ job: JobDTO }> = (props) => {
  const analysis = () => props.job.pitch!;
  const [trackLabel, setTrackLabel] = createSignal(analysis().tracks[0]?.label ?? "");
  const [zoom, setZoom] = createSignal(100);
  const [position, setPosition] = createSignal(0);
  const [selectedNote, setSelectedNote] = createSignal<PitchNoteDTO | null>(null);
  const [selectedWord, setSelectedWord] = createSignal<number | null>(null);
  const [follow, setFollow] = createSignal(true);
  let audio!: HTMLAudioElement;
  let viewport!: HTMLDivElement;
  const track = createMemo(() => analysis().tracks.find(item => item.label === trackLabel()) ?? analysis().tracks[0]);
  const notes = () => track()?.notes ?? [];
  const rows = createMemo(() => {
    const values = notes().map(note => Math.round(note.midi));
    const low = values.length ? Math.min(...values) - 2 : 48;
    const high = values.length ? Math.max(...values) + 2 : 72;
    return Array.from({ length: high - low + 1 }, (_, index) => high - index);
  });
  const pitchHeight = () => rows().length * ROW_HEIGHT;
  const width = () => Math.max(600, analysis().duration_s * zoom());
  const ticks = createMemo<TimeTick[]>(() => {
    const step = zoom() >= 320 ? 0.25 : zoom() >= 160 ? 0.5 : zoom() >= 80 ? 1 : 2;
    return Array.from({ length: Math.floor(analysis().duration_s / step) + 1 }, (_, index) => {
      const seconds = index * step;
      return { seconds, label: step < 1 ? timeLabel(seconds) : timeLabel(seconds).slice(0, -3) };
    });
  });
  const matchingOutput = () => props.job.manifest?.some(item => item.label === track()?.label);
  const songOutput = () => props.job.manifest?.some(item => item.label === "song");
  const sourceClock = () => !matchingOutput() && !songOutput();
  const referenceUrl = () => matchingOutput() ? resultUrl(props.job.id, track()!.label)
    : songOutput() ? resultUrl(props.job.id, "song") : originalUrl(props.job.id);
  const referenceLabel = () => matchingOutput() ? displayOutputLabel(track()!.label, props.job.options)
    : songOutput() ? "Transformed full song (not isolated vocals)" : "Original full song (unchanged, not isolated vocals)";
  const toAudioTime = (seconds: number) => sourceClock() ? seconds * analysis().tempo_percent / 100 : seconds;
  const fromAudioTime = (seconds: number) => sourceClock() ? seconds / (analysis().tempo_percent / 100) : seconds;
  const seek = (seconds: number) => {
    setPosition(seconds);
    if (audio) audio.currentTime = toAudioTime(seconds);
  };
  const selectNote = (note: PitchNoteDTO) => {
    setSelectedNote(note);
    setSelectedWord(null);
    seek(note.start_s);
  };
  const noteDescription = (note: PitchNoteDTO) => `${note.note}, ${note.cents >= 0 ? "+" : ""}${note.cents} cents; ${timeLabel(note.start_s)}–${timeLabel(note.end_s)}; confidence ${Math.round(note.confidence * 100)}%`;
  const changeZoom = (next: number) => {
    const old = zoom();
    const center = viewport ? (viewport.scrollLeft + viewport.clientWidth / 2 - AXIS_WIDTH) / old : 0;
    setZoom(next);
    if (viewport) viewport.scrollLeft = Math.max(0, center * next - viewport.clientWidth / 2 + AXIS_WIDTH);
  };
  createEffect(() => {
    // Native source changes stop the old track, preserving the global playback
    // guard's single-audio invariant. Do not autoplay on track selection.
    referenceUrl();
    track()?.label;
    setPosition(0);
    setSelectedNote(null);
    setSelectedWord(null);
    if (audio) audio.load();
  });
  createEffect(() => {
    // Keep the typical vocal register visible without hiding high/low outliers.
    // All rows remain reachable by vertical scroll, including on short phones.
    const pitches = notes().map(note => note.midi).sort((left, right) => left - right);
    if (!viewport || pitches.length === 0) return;
    const middle = pitches[Math.floor(pitches.length / 2)];
    const rowCenter = 32 + (rows()[0] - middle + 0.5) * ROW_HEIGHT;
    const availableHeight = viewport.clientHeight - (analysis().word_alignment ? 64 : 0);
    viewport.scrollTop = Math.max(0, rowCenter - availableHeight / 2);
  });
  const updatePosition = () => {
    const next = fromAudioTime(audio.currentTime);
    setPosition(next);
    if (follow() && !audio.paused && viewport) {
      const x = AXIS_WIDTH + next * zoom();
      if (x > viewport.scrollLeft + viewport.clientWidth - 40 || x < viewport.scrollLeft + AXIS_WIDTH) {
        viewport.scrollLeft = Math.max(0, x - AXIS_WIDTH - 30);
      }
    }
  };

  return (
    <section class="pitch-view" aria-label="Vocal pitch analysis">
      <div class="pitch-heading">
        <h3 class="text-base font-semibold">Vocal pitch timeline</h3>
        <a href={pitchDownloadUrl(props.job.id)} download="" class="text-sm font-medium text-primary hover:underline">Download pitch JSON</a>
      </div>
      <p class="text-sm text-muted-foreground">Time → · musical pitch ↑ · output audio clock and pitch. Notes are detected on original vocal stems, then projected by {analysis().pitch_shift_semitones >= 0 ? "+" : ""}{analysis().pitch_shift_semitones} semitones and {analysis().tempo_percent}% tempo; not re-measured after processing.</p>
      <p class="text-xs text-muted-foreground">CREPE full · monophonic melody estimate, not a score. Harmonies, bleed and octave errors can be wrong; silence and low-confidence frames are omitted.</p>
      <div class="pitch-controls">
        <label>Vocal stem
          <select aria-label="Pitch vocal stem" value={track()?.label} onChange={event => setTrackLabel(event.currentTarget.value)}>
            <For each={analysis().tracks}>{item => <option value={item.label}>{item.label}</option>}</For>
          </select>
        </label>
        <div class="pitch-zoom" role="group" aria-label="Timeline zoom">
          <Button type="button" variant="outline" aria-label="Zoom out melody" disabled={zoom() <= MIN_ZOOM} onClick={() => changeZoom(zoom() - ZOOM_STEP)}>−</Button>
          <label class="pitch-zoom-value">
            <span aria-live="polite">{zoom()} px/s</span>
            <input type="range" aria-label="Melody zoom" min={MIN_ZOOM} max={MAX_ZOOM} step={ZOOM_STEP}
              value={zoom()} onInput={event => changeZoom(event.currentTarget.valueAsNumber)} />
          </label>
          <Button type="button" variant="outline" aria-label="Zoom in melody" disabled={zoom() >= MAX_ZOOM} onClick={() => changeZoom(zoom() + ZOOM_STEP)}>+</Button>
        </div>
        <label class="pitch-follow"><input type="checkbox" checked={follow()} onChange={event => setFollow(event.currentTarget.checked)} /> Follow playback</label>
      </div>
      <p class="text-sm">Reference audio: <strong>{referenceLabel()}</strong>.</p>
      <Show when={sourceClock() && analysis().tempo_percent !== 100}>
        <p class="text-xs text-muted-foreground">Original-speed playback uses its original clock, mapped to the output timeline. Choose a generated vocal output for matching transformed playback.</p>
      </Show>
      <audio ref={audio} aria-label={`Pitch reference: ${referenceLabel()}`} controls preload="none" class="w-full" src={referenceUrl()} onTimeUpdate={updatePosition} onSeeked={updatePosition} />
      <p class="text-xs text-muted-foreground">Swipe or scroll horizontally; zoom for short notes. Tap a note to seek and inspect it. Playback position: {timeLabel(position())} (output time).</p>
      <Show when={analysis().word_alignment}>
        <p class="pitch-alignment-notice">Approximate Whisper word alignment from full vocals, not exact syllable timing or independent recognition of split voices. Words below the notes may be wrong or misaligned. Select a word to highlight its linked notes; one word can span several notes (melisma).</p>
      </Show>
      <Show when={analysis().word_alignment && analysis().words.length === 0}>
        <p class="text-sm text-muted-foreground">No sung words were recognized; pitch notes remain available.</p>
      </Show>
      <Show when={!analysis().word_alignment}>
        <p class="text-xs text-muted-foreground">Request lyrics together with pitch to add approximate sung-word associations.</p>
      </Show>
      <Show when={notes().length > 0} fallback={<p role="status" class="text-sm text-muted-foreground">No confident voiced notes detected in this stem.</p>}>
        <div ref={viewport} class="pitch-viewport" tabIndex={0} role="region" aria-label="Scrollable vocal melody timeline">
          <div class="pitch-canvas" style={{ width: `${width() + AXIS_WIDTH}px` }}>
            <div class="pitch-ruler" style={{ width: `${width() + AXIS_WIDTH}px` }}>
              <span class="pitch-axis-corner">Note</span>
              <For each={ticks()}>{tick => <span style={{ left: `${AXIS_WIDTH + tick.seconds * zoom()}px` }}>{tick.label}</span>}</For>
            </div>
            <div class="pitch-notes" style={{ height: `${pitchHeight()}px` }}>
              <div class="pitch-axis" style={{ height: `${pitchHeight()}px` }}>
                <For each={rows()}>{midi => <div classList={{ "pitch-black-key": NOTE_NAMES[((midi % 12) + 12) % 12].includes("#") }} style={{ height: `${ROW_HEIGHT}px` }}>{noteName(midi)}</div>}</For>
              </div>
              <svg class="pitch-svg" width={width()} height={pitchHeight()} style={{ left: `${AXIS_WIDTH}px` }} aria-label={`${track()?.label} detected notes`}>
                <For each={rows()}>{(_, index) => <line x1="0" x2={width()} y1={index() * ROW_HEIGHT} y2={index() * ROW_HEIGHT} class="pitch-grid" />}</For>
                <For each={ticks()}>{tick => <line x1={tick.seconds * zoom()} x2={tick.seconds * zoom()} y1="0" y2={pitchHeight()} class="pitch-grid" />}</For>
                <For each={notes()}>{note => {
                  const x = () => note.start_s * zoom();
                  const y = () => (rows()[0] - Math.round(note.midi)) * ROW_HEIGHT + 2;
                  const noteWidth = () => Math.max(2, (note.end_s - note.start_s) * zoom());
                  return <g class="pitch-note" classList={{ "pitch-note-selected": note === selectedNote() || (selectedWord() !== null && note.word_indices.includes(selectedWord()!)) }} role="button" tabIndex={0}
                    aria-label={noteDescription(note)} data-note={note.note} data-start={note.start_s} data-end={note.end_s}
                    onClick={() => selectNote(note)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNote(note); } }}>
                    <title>{noteDescription(note)}</title>
                    <rect x={x()} y={y()} width={noteWidth()} height={ROW_HEIGHT - 4} rx="3" />
                    <text x={x() + noteWidth() / 2} y={y() + 14} text-anchor="middle" font-size="12"
                      textLength={Math.min(note.note.length * 7.2, Math.max(1, noteWidth() - 2))} lengthAdjust="spacingAndGlyphs">{note.note}</text>
                  </g>;
                }}</For>
                <line x1={position() * zoom()} x2={position() * zoom()} y1="0" y2={pitchHeight()} class="pitch-playhead" />
              </svg>
            </div>
            <Show when={analysis().word_alignment}>
              <div class="pitch-words" style={{ width: `${width() + AXIS_WIDTH}px` }} aria-label="Approximate sung words">
                <span class="pitch-word-label">Words<br /><small>≈ timing</small></span>
                <For each={analysis().words}>{(word, index) => {
                  const linked = createMemo(() => notes().filter(note => note.word_indices.includes(index())));
                  return <button type="button" class="pitch-word" classList={{ "pitch-word-selected": selectedWord() === index() || (selectedNote()?.word_indices.includes(index()) ?? false), "pitch-word-unlinked": linked().length === 0 }}
                    style={{ left: `${AXIS_WIDTH + word.start_s * zoom()}px`, width: `${Math.max(4, (word.end_s - word.start_s) * zoom())}px` }}
                    aria-label={`${word.text}, approximate word timing; ${linked().length} linked notes`}
                    title={`${word.text} · ${timeLabel(word.start_s)}–${timeLabel(word.end_s)} · ${linked().length} linked notes`}
                    onClick={() => { setSelectedWord(index()); setSelectedNote(null); seek(linked()[0]?.start_s ?? word.start_s); }}>
                    {word.text}<Show when={linked().length > 1}><small> · {linked().length} notes</small></Show>
                  </button>;
                }}</For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
      <div class="pitch-selection" aria-live="polite">
        <Show when={selectedNote()} fallback={<Show when={selectedWord() === null}><span>Select a note or word for details.</span></Show>}>{note => <>
          <strong>{note().note}</strong> · {note().cents >= 0 ? "+" : ""}{note().cents} cents · {note().frequency_hz.toFixed(1)} Hz · {timeLabel(note().start_s)}–{timeLabel(note().end_s)} · confidence {Math.round(note().confidence * 100)}%
          <Show when={note().word_indices.length > 0}><span> · Approximate words: {note().word_indices.map(index => analysis().words[index].text).join(" ")}</span></Show>
        </>}</Show>
        <Show when={selectedWord() !== null}><span>“{analysis().words[selectedWord()!].text}” · {notes().filter(note => note.word_indices.includes(selectedWord()!)).length} linked notes (approximate full-vocal word alignment).</span></Show>
      </div>
    </section>
  );
};

export default PitchView;
