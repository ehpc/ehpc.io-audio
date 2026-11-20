import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
  const repeatBounds = createMemo(() => {
    const bounds = section(), duration = mediaDuration();
    return bounds && Number.isFinite(bounds.start_s) && Number.isFinite(bounds.end_s)
      && bounds.start_s >= 0 && bounds.start_s < bounds.end_s && bounds.end_s <= duration
      ? bounds : null;
  });
  const visibleLines = createMemo(() => {
    const bounds = section();
    return (document()?.lines ?? []).filter(line => !bounds || line.onset_s === null
      || (line.onset_s >= bounds.start_s && line.onset_s < bounds.end_s));
  });
  const current = createMemo(() => visibleLines().find(line => line.id === document()?.progress.line_id) ?? visibleLines()[0]);
  const currentParts = createMemo(() => studyParts(current()?.text ?? ""));
  const hint = () => document()?.progress.hint_level ?? "full";
  const clearReveals = () => { setRevealed(new Set<number>()); setLineRevealed(false); };
  onMount(() => {
    void learningProgress(props.job.id).then(value => {
      if (live) setDocument(value);
    }, reason => {
      if (live) setError(reason instanceof Error ? reason.message : "Learning progress could not be loaded.");
    });
  });
  onCleanup(() => { live = false; setLoop(false); audio?.pause(); });
  const patch = async (changes: Omit<LearningPreferences, "document_version">) => {
    const value = document();
    if (!value || busy()) return;
    clearReveals();
    if ("section_id" in changes) { setLoop(false); audio?.pause(); }
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
    const bounds = repeatBounds();
    if (busy() || !bounds || !audio || !Number.isFinite(audio.duration)
      || bounds.end_s > audio.duration) return;
    if (!loop() && (audio.currentTime < bounds.start_s || audio.currentTime >= bounds.end_s)) audio.currentTime = bounds.start_s;
    setLoop(!loop());
  };
  const enforceLoop = () => {
    const bounds = repeatBounds();
    if (loop() && bounds && audio && Number.isFinite(audio.duration)
      && bounds.end_s <= audio.duration && audio.currentTime >= bounds.end_s) audio.currentTime = bounds.start_s;
  };
  const canSeekLine = (time: number | null) => time !== null && Number.isFinite(time)
    && time >= 0 && time < mediaDuration();
  const seekLine = (time: number | null) => {
    if (audio && canSeekLine(time) && time !== null && Number.isFinite(audio.duration)
      && time < audio.duration) audio.currentTime = time;
  };
  const syncDuration = () => {
    const duration = audio?.duration;
    setMediaDuration(duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : 0);
    if (!repeatBounds()) setLoop(false);
  };
  return <div class="learn-body">
    <Show when={error()}><p role="alert" class="auth-error">{error()}</p></Show>
    <Show when={document()} fallback={<Show when={!error()}><p role="status">Loading lyrics…</p></Show>}>{value => <>
      <Show when={!value().saving_available}><p role="status">Saving unavailable: the original recording could not be verified. You can still practise manually in this view.</p></Show>
      <Show when={props.job.has_original} fallback={<p>Original audio is unavailable; lyrics can still be practised manually.</p>}>
        <audio ref={audio} controls preload="metadata" class="learn-audio" src={playbackUrl(originalUrl(props.job.id))} onLoadedMetadata={syncDuration} onDurationChange={syncDuration} onTimeUpdate={enforceLoop} onEnded={() => {
          const bounds = repeatBounds();
          if (loop() && bounds && audio && Number.isFinite(audio.duration) && bounds.end_s <= audio.duration) {
            audio.currentTime = bounds.start_s; void audio.play().catch(() => { if (live) setError("Audio playback could not be resumed."); });
          }
        }} />
      </Show>
      <div class="learn-settings">
        <label for="learn-section">Practice section</label>
        <select id="learn-section" value={value().progress.section_id ?? ""} disabled={busy()} onChange={event => void patch({ section_id: event.currentTarget.value || null })}>
          <option value="">All lyrics / manual navigation</option>
          <For each={value().sections}>{(item, index) => <option value={item.id}>{item.label} {index() + 1}</option>}</For>
        </select>
        <Button type="button" variant="outline" disabled={busy() || !repeatBounds() || !props.job.has_original} aria-pressed={loop()} onClick={toggleLoop}>Repeat section</Button>
      </div>
      <Show when={value().sections.length > 0}><p class="learn-note">Section labels and boundaries are automatic estimates.</p></Show>
      <Show when={section() && mediaDuration() > 0 && !repeatBounds()}><p class="learn-note">This estimated section falls outside the recording and cannot be repeated.</p></Show>
      <Show when={section() && visibleLines().some(line => line.onset_s === null)}><p class="learn-note">Unplaced lines have no section timing and are not included in section repeat.</p></Show>
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
          <Button type="button" variant="outline" disabled={!canSeekLine(line().onset_s) || !props.job.has_original} onClick={() => seekLine(line().onset_s)}>Seek to line</Button>
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
