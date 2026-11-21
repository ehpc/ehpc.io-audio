import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { JobDTO, LearningDocument, LearningHint, LearningPreferences, LearningRating } from "~/api";
import { learningProgress, originalUrl, playbackUrl, reviewLearningLine, saveLearningPreferences } from "~/api";
import { Button } from "~/components/button";
import { studyHint, studyParts } from "~/lib/learning";

const levels: LearningHint[] = ["full", "partial", "first", "hidden"];
const levelNames: Record<LearningHint, string> = { full: "Full lyrics", partial: "Partial words", first: "First letters", hidden: "No text" };

export default function LearnLyrics(props: { job: JobDTO }) {
  const [document, setDocument] = createSignal<LearningDocument>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [loop, setLoop] = createSignal(false);
  const [mediaDuration, setMediaDuration] = createSignal(0);
  const [revealed, setRevealed] = createSignal<Set<number>>(new Set());
  const [lineRevealed, setLineRevealed] = createSignal(false);
  let audio: HTMLAudioElement | undefined;
  let live = true;
  const section = createMemo(() => document()?.sections.find(item => item.id === document()?.progress.section_id));
  const visibleLines = createMemo(() => {
    const bounds = section();
    return (document()?.lines ?? []).filter(line => !bounds || line.onset_s === null
      || (line.onset_s >= bounds.start_s && line.onset_s < bounds.end_s));
  });
  const current = createMemo(() => visibleLines().find(line => line.id === document()?.progress.line_id) ?? visibleLines()[0]);
  const currentParts = createMemo(() => studyParts(current()?.text ?? ""));
  const hint = () => document()?.progress.hint_level ?? "full";
  const lineBounds = createMemo(() => {
    const value = document(), line = current(), duration = mediaDuration();
    const start = line?.onset_s;
    if (!value || !line || start == null || !Number.isFinite(start) || start < 0 || start >= duration) return null;
    const index = value.lines.findIndex(item => item.id === line.id);
    if (index < 0) return null;
    let next: number | null = null;
    let nextIndex = -1;
    value.lines.forEach((item, position) => {
      const onset = item.onset_s;
      if (position !== index && onset !== null && Number.isFinite(onset)
        && onset > start && onset <= duration && (next === null || onset < next)) {
        next = onset;
        nextIndex = position;
      }
    });
    const intervening = nextIndex > index
      && value.lines.slice(index + 1, nextIndex).some(item => item.onset_s === null);
    const explicit = line.end_s !== null && Number.isFinite(line.end_s) && line.end_s > start && line.end_s <= duration ? line.end_s : null;
    const cutoff = intervening ? null : next;
    const hasUnknownLater = value.lines.slice(index + 1).some(item => item.onset_s === null);
    const end = explicit !== null && cutoff !== null ? Math.min(explicit, cutoff)
      : explicit ?? cutoff ?? (next === null && !hasUnknownLater ? duration : null);
    return end !== null && end > start ? { start, end } : null;
  });
  let syncedLine: string | undefined;
  let syncedDuration = 0;
  let previousPractice = false;
  let playbackFrame: number | undefined;
  let boundaryTimer: number | undefined;
  const stopClock = () => {
    if (playbackFrame !== undefined) cancelAnimationFrame(playbackFrame);
    clearTimeout(boundaryTimer);
    playbackFrame = undefined;
    boundaryTimer = undefined;
  };
  createEffect(() => {
    const line = current(), duration = mediaDuration(), practice = hint() !== "full";
    const changed = line?.id !== syncedLine || duration !== syncedDuration || (practice && !previousPractice);
    syncedLine = line?.id;
    syncedDuration = duration;
    previousPractice = practice;
    if (!changed || !audio || !duration) return;
    const bounds = lineBounds();
    if (!bounds) { audio.pause(); return; }
    audio.currentTime = bounds.start;
  });
  const clearReveals = () => { setRevealed(new Set<number>()); setLineRevealed(false); };
  onMount(() => {
    void learningProgress(props.job.id).then(value => {
      if (live) setDocument(value);
    }, reason => {
      if (live) setError(reason instanceof Error ? reason.message : "Learning progress could not be loaded.");
    });
  });
  onCleanup(() => { live = false; stopClock(); audio?.pause(); });
  const patch = async (changes: Omit<LearningPreferences, "document_version">) => {
    const value = document();
    if (!value || busy()) return;
    clearReveals();
    if ("section_id" in changes) setLoop(false);
    if (!value.saving_available) {
      setDocument({ ...value, progress: { ...value.progress, ...changes } });
      return;
    }
    setBusy(true); setError("");
    try {
      const next = await saveLearningPreferences(props.job.id, { document_version: value.document_version, ...changes });
      if (live) setDocument(next);
    } catch (reason) {
      if (live) setError(`Changes were not saved. ${reason instanceof Error ? reason.message : "Please try again."}`);
    } finally { if (live) setBusy(false); }
  };
  const rate = async (rating: LearningRating) => {
    const value = document(), line = current();
    if (!value || !line || busy() || !value.saving_available) return;
    setBusy(true); setError("");
    try {
      const next = await reviewLearningLine(props.job.id, value.document_version, line.id, rating);
      if (live) { setDocument(next); clearReveals(); }
    } catch (reason) {
      if (live) setError(`Review was not saved. ${reason instanceof Error ? reason.message : "Please try again."}`);
    } finally { if (live) setBusy(false); }
  };
  const changeHint = (step: number) => {
    const index = Math.max(0, Math.min(levels.length - 1, levels.indexOf(hint()) + step));
    void patch({ hint_level: levels[index] });
  };
  const toggleLoop = () => {
    if (busy() || !lineBounds() || !audio) return;
    setLoop(!loop());
  };
  const enforceBoundary = () => {
    if (!audio || audio.paused) return;
    const bounds = lineBounds();
    if (!bounds) { audio.pause(); stopClock(); return; }
    if (audio.currentTime >= bounds.end) {
      if (loop() && !busy() && !audio.ended) audio.currentTime = bounds.start;
      else { audio.pause(); audio.currentTime = bounds.end; stopClock(); }
    }
  };
  const handleSeeking = () => {
    const bounds = lineBounds();
    if (audio && !audio.paused && (!bounds || audio.currentTime < bounds.start || audio.currentTime >= bounds.end)) {
      audio.pause();
      stopClock();
    }
  };
  const startClock = () => {
    stopClock();
    if (!audio) return;
    const bounds = lineBounds();
    if (!bounds) { audio.pause(); return; }
    if (audio.currentTime < bounds.start || audio.currentTime >= bounds.end) audio.currentTime = bounds.start;
    const frame = () => {
      playbackFrame = undefined;
      if (!audio || audio.paused) return;
      enforceBoundary();
      if (!audio.paused) playbackFrame = requestAnimationFrame(frame);
    };
    const timer = () => {
      boundaryTimer = undefined;
      if (!audio || audio.paused) return;
      enforceBoundary();
      if (!audio.paused) {
        const remaining = Math.max(0.01, (lineBounds()?.end ?? audio.currentTime) - audio.currentTime);
        boundaryTimer = window.setTimeout(timer, Math.max(10, remaining * 1000 / Math.max(0.01, audio.playbackRate)));
      }
    };
    playbackFrame = requestAnimationFrame(frame);
    timer();
  };
  const seekLine = (time: number | null) => {
    if (audio && time !== null && lineBounds() && time === lineBounds()?.start) audio.currentTime = time;
  };
  const syncDuration = () => {
    const duration = audio?.duration;
    setMediaDuration(duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : 0);
    if (!lineBounds()) setLoop(false);
  };
  return <div class="learn-body">
    <Show when={error()}><p role="alert" class="auth-error">{error()}</p></Show>
    <Show when={document()} fallback={<Show when={!error()}><p role="status">Loading lyrics…</p></Show>}>{value => <>
      <Show when={!value().saving_available}><p role="status">Saving unavailable: the original recording could not be verified. You can still practise manually in this view.</p></Show>
      <Show when={props.job.has_original} fallback={<p>Original audio is unavailable; lyrics can still be practised manually.</p>}>
        <audio ref={audio} controls preload="metadata" class="learn-audio" src={playbackUrl(originalUrl(props.job.id))}
          onLoadedMetadata={syncDuration} onDurationChange={syncDuration} onPlay={startClock} onPause={stopClock}
          onTimeUpdate={enforceBoundary} onSeeking={handleSeeking} onSeeked={() => {
            enforceBoundary();
            if (audio && !audio.paused) startClock();
          }}
          onRateChange={() => { if (audio && !audio.paused) startClock(); }}
          onEnded={() => {
            stopClock();
            const bounds = lineBounds();
            if (loop() && !busy() && bounds && audio) {
              audio.currentTime = bounds.start;
              void audio.play().catch(() => { if (live) setError("Audio playback could not be resumed."); });
            }
          }} />
      </Show>
      <div class="learn-settings">
        <label for="learn-section">Practice section</label>
        <select id="learn-section" value={value().progress.section_id ?? ""} disabled={busy()} onChange={event => void patch({ section_id: event.currentTarget.value || null })}>
          <option value="">All lyrics / manual navigation</option>
          <For each={value().sections}>{(item, index) => <option value={item.id}>{item.label} {index() + 1}</option>}</For>
        </select>
        <Button type="button" variant="outline" disabled={busy() || !lineBounds() || !props.job.has_original} aria-pressed={loop()} onClick={toggleLoop}>Repeat line</Button>
      </div>
      <Show when={value().sections.length > 0}><p class="learn-note">Section labels and boundaries are automatic estimates.</p></Show>
      <Show when={!lineBounds() && mediaDuration() > 0}><p class="learn-note">This line has no supported playback bounds. You can reveal it and seek manually; playback is paused until a timed line is selected.</p></Show>
      <Show when={section() && visibleLines().some(line => line.onset_s === null)}><p class="learn-note">Unplaced lines have no section timing.</p></Show>
      <p class="learn-stage">{levelNames[hint()]}</p>
      <div class="learn-actions">
        <Show when={hint() === "full"}>
          <Button type="button" disabled={busy()} onClick={() => void patch({ hint_level: "partial" })}>Practice</Button>
        </Show>
        <Button type="button" variant="outline" disabled={busy() || hint() === "full"} onClick={() => changeHint(-1)}>More hints</Button>
        <Button type="button" variant="outline" disabled={busy() || hint() === "hidden"} onClick={() => changeHint(1)}>Fewer hints</Button>
      </div>
      <Show when={hint() === "full"} fallback={<Show when={current()}>{line => <section aria-label="Practice line" class="learn-line">
        <div class="learn-words"><For each={currentParts()}>{(part, index) => {
          const wordNumber = () => currentParts().slice(0, index() + 1).filter(item => item.word).length;
          return <Show when={part.word} fallback={<span>{part.text}</span>}><button type="button" class="learn-word" aria-label={revealed().has(index()) || lineRevealed() ? `Word ${wordNumber()}: ${part.text}` : `Reveal word ${wordNumber()}`} onClick={() => setRevealed(previous => new Set([...previous, index()]))}>{lineRevealed() || revealed().has(index()) ? part.text : studyHint(part.text, hint())}</button></Show>;
        }}</For></div>
        <div class="learn-actions">
          <Button type="button" variant="outline" onClick={() => setLineRevealed(true)}>Reveal line</Button>
          <Button type="button" variant="outline" disabled={!lineBounds() || !props.job.has_original} onClick={() => seekLine(line().onset_s)}>Seek to line</Button>
        </div>
        <Show when={line().onset_source === "provider-synced"}><p class="learn-note">Line cue: provider-synced; not word timing.</p></Show>
        <Show when={line().onset_s === null}><p class="learn-note">No supported line timing; use the player to seek manually.</p></Show>
        <div class="learn-actions" aria-label="Rate recall">
          <For each={(["remembered", "hesitated", "forgot"] as const)}>{rating => <Button type="button" variant="outline" disabled={busy() || !value().saving_available} onClick={() => void rate(rating)}>{rating[0].toUpperCase() + rating.slice(1)}</Button>}</For>
        </div>
      </section>}</Show>}>
        <p>Listen with the lyrics, then choose Practice when you are ready.</p>
      </Show>
      <div class="learn-navigation"><p>Choose a line</p><ol><For each={visibleLines()}>{(line, index) => <li><button type="button" aria-current={current()?.id === line.id ? "true" : undefined} disabled={busy()} onClick={() => void patch({ line_id: line.id })}>{hint() === "full" ? line.text : `Line ${index() + 1}`}{line.onset_s === null ? " (unplaced)" : ""}</button></li>}</For></ol></div>
    </>}</Show>
  </div>;
}
