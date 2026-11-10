import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import type { JobDTO, PitchNoteDTO } from "~/api";
import { originalUrl, pitchDownloadUrl, pitchVocalsUrl, playbackUrl, recoverPitchVocals, resultUrl } from "~/api";
import { displayOutputLabel } from "~/lib/expectedStems";
import { NOTE_NAMES, noteName } from "~/lib/pitchNotes";
import { Button } from "~/components/button";
import TimelineKaraoke from "./TimelineKaraoke";
import PianoKeyboard from "./PianoKeyboard";

const ROW_HEIGHT = 24;
const AXIS_WIDTH = 54;
const MIN_ZOOM = 40;
const MAX_ZOOM = 640;
const ZOOM_STEP = 20;
function timeLabel(seconds: number): string {
  const centiseconds = Math.round(seconds * 100);
  const minutes = Math.floor(centiseconds / 6000);
  return `${minutes}:${((centiseconds % 6000) / 100).toFixed(2).padStart(5, "0")}`;
}

interface TimeTick {
  seconds: number;
  label: string;
}

interface PitchTooltip {
  key: object;
  note?: string;
  lyrics: string;
  x: number;
  y: number;
  below: boolean;
}

const PitchTimeline: Component<{ job: JobDTO }> = (props) => {
  const analysis = () => props.job.pitch!;
  const [trackLabel, setTrackLabel] = createSignal(analysis().tracks[0]?.label ?? "");
  const [zoom, setZoom] = createSignal(100);
  const [position, setPosition] = createSignal(0);
  const [selectedNote, setSelectedNote] = createSignal<PitchNoteDTO | null>(null);
  const [selectedWord, setSelectedWord] = createSignal<number | null>(null);
  const [follow, setFollow] = createSignal(true);
  const [browsing, setBrowsing] = createSignal(false);
  const [playbackError, setPlaybackError] = createSignal("");
  const [referenceError, setReferenceError] = createSignal("");
  const [nativePaused, setNativePaused] = createSignal(true);
  const [seeking, setSeeking] = createSignal(false);
  const [seekRevision, setSeekRevision] = createSignal(0);
  const [recoveredVocals, setRecoveredVocals] = createSignal(false);
  const [recoveringVocals, setRecoveringVocals] = createSignal(false);
  const [recoveryError, setRecoveryError] = createSignal("");
  const [tooltip, setTooltip] = createSignal<PitchTooltip | null>(null);
  const tooltipId = createUniqueId();
  const backgroundHelpId = createUniqueId();
  const dismissTooltip = () => setTooltip(null);
  let audio!: HTMLAudioElement;
  let viewport!: HTMLDivElement;
  let lastScrollLeft = 0;
  let lastScrollTop = 0;
  let programmedScroll: { left: number; top: number } | undefined;
  let userScroll = false;
  let legacyScroll = false;
  let userScrolled = false;
  let returnedToPlayhead = false;
  let scrollSettled = false;
  let activePointer: number | null = null;
  let touching = false;
  const heldScrollKeys = new Set<string>();
  let settlingFrame: number | undefined;
  let playbackFrame: number | undefined;
  let playAttempt = 0;
  const gestureActive = () => activePointer !== null || touching || heldScrollKeys.size > 0;
  const hasNativeScrollEnd = () => "onscrollend" in viewport;
  const cancelSettling = () => {
    if (settlingFrame !== undefined) cancelAnimationFrame(settlingFrame);
    settlingFrame = undefined;
  };
  const finishUserScroll = () => {
    if (gestureActive()) return;
    // Remember the user's return, even if playback has since left the view.
    // Only subsequent manual panning away can revoke that return.
    if (returnedToPlayhead) setBrowsing(false);
    userScroll = false;
    userScrolled = false;
    returnedToPlayhead = false;
    scrollSettled = false;
    cancelSettling();
  };
  const settleLegacyScroll = () => {
    if (!viewport || hasNativeScrollEnd() || gestureActive() || !userScroll) return;
    cancelSettling();
    let left = viewport.scrollLeft;
    let top = viewport.scrollTop;
    let paintedStill = false;
    const sample = () => {
      settlingFrame = undefined;
      if (gestureActive() || !userScroll) return;
      const still = left === viewport.scrollLeft && top === viewport.scrollTop;
      if (still && paintedStill) {
        finishUserScroll();
        return;
      }
      paintedStill = still;
      left = viewport.scrollLeft;
      top = viewport.scrollTop;
      settlingFrame = requestAnimationFrame(sample);
    };
    settlingFrame = requestAnimationFrame(sample);
  };
  const armUserScroll = () => {
    userScroll = true;
    legacyScroll = !hasNativeScrollEnd();
    scrollSettled = false;
    cancelSettling();
  };
  const releaseGesture = () => {
    if (gestureActive()) return;
    if (!userScrolled || scrollSettled) finishUserScroll();
    else settleLegacyScroll();
  };
  const moveViewport = (left: number, top = viewport.scrollTop) => {
    returnedToPlayhead = false;
    viewport.scrollLeft = Math.max(0, left);
    viewport.scrollTop = Math.max(0, top);
    lastScrollLeft = viewport.scrollLeft;
    lastScrollTop = viewport.scrollTop;
    programmedScroll = { left: lastScrollLeft, top: lastScrollTop };
  };
  const onTimelineScroll = () => {
    const left = viewport.scrollLeft;
    const top = viewport.scrollTop;
    const previousLeft = lastScrollLeft;
    const previousTop = lastScrollTop;
    lastScrollLeft = left;
    lastScrollTop = top;
    const programmed = programmedScroll;
    programmedScroll = undefined;
    if (programmed?.left === left && programmed.top === top) return;
    if (left === previousLeft && top === previousTop) return;
    // Legacy browsers can deliver inertia after a briefly stationary frame.
    // Keep recognizing that gesture; our own scroll writes are excluded above.
    if (!userScroll && legacyScroll) userScroll = true;
    if (!userScroll) return;
    userScrolled = true;
    scrollSettled = false;
    setBrowsing(true);
    if (left !== previousLeft) {
      const x = AXIS_WIDTH + position() * zoom();
      const visibleAt = (offset: number) => x >= offset + AXIS_WIDTH && x < offset + viewport.clientWidth;
      const distanceAt = (offset: number) => Math.max(offset + AXIS_WIDTH - x, x - offset - viewport.clientWidth, 0);
      const wasVisible = visibleAt(previousLeft);
      const isVisible = visibleAt(left);
      if (!wasVisible && isVisible) returnedToPlayhead = true;
      else if (!isVisible && (wasVisible || distanceAt(left) > distanceAt(previousLeft))) returnedToPlayhead = false;
    }
    settleLegacyScroll();
  };
  const syncNativePlayback = () => setNativePaused(audio.paused || audio.ended || Boolean(audio.error));
  const stopPlaybackClock = () => {
    if (playbackFrame !== undefined) cancelAnimationFrame(playbackFrame);
    playbackFrame = undefined;
    if (audio) syncNativePlayback();
  };
  const startPlaybackClock = () => {
    stopPlaybackClock();
    setPlaybackError("");
    const frame = () => {
      playbackFrame = undefined;
      if (audio.paused || audio.ended || audio.error) return;
      updatePosition();
      playbackFrame = requestAnimationFrame(frame);
    };
    playbackFrame = requestAnimationFrame(frame);
  };
  const showTooltip = (target: Element, key: object, lyrics: string, note?: string) => {
    const rect = target.getBoundingClientRect();
    const visible = viewport.getBoundingClientRect();
    const left = Math.max(rect.left, visible.left + AXIS_WIDTH);
    const right = Math.min(rect.right, visible.right);
    const top = Math.max(rect.top, visible.top + 32);
    const bottom = Math.min(rect.bottom, visible.bottom);
    const below = top < 80;
    const margin = Math.min(160, window.innerWidth / 2);
    setTooltip({
      key, note, lyrics, below,
      x: Math.max(margin, Math.min(window.innerWidth - margin, (left + right) / 2)),
      y: below ? bottom + 8 : top - 8,
    });
  };
  const showNoteTooltip = (target: Element, note: PitchNoteDTO) => {
    showTooltip(target, note, note.word_indices.map(index => analysis().words[index]?.text).filter(Boolean).join(" "), note.note);
  };
  onMount(() => {
    window.addEventListener("scroll", dismissTooltip, true);
    window.addEventListener("resize", dismissTooltip);
    const pointerEnded = (event: PointerEvent) => {
      if (event.pointerId !== activePointer) return;
      activePointer = null;
      // Touch panning cancels the pointer before the finger and inertia finish.
      if (event.type !== "pointercancel") releaseGesture();
      else settleLegacyScroll();
    };
    const touchEnded = (event: TouchEvent) => {
      if (event.touches.length === 0) {
        touching = false;
        releaseGesture();
      }
    };
    const keyEnded = (event: KeyboardEvent) => {
      heldScrollKeys.delete(event.key);
      releaseGesture();
    };
    const scrollEnded = (event: Event) => {
      if (event.target !== viewport || !userScroll || !userScrolled) return;
      scrollSettled = true;
      finishUserScroll();
    };
    const otherAudioStarted = (event: Event) => {
      if (event.target instanceof HTMLAudioElement && event.target !== audio
        && (!pending || event.target !== slots[pending.slot])) cancelReference(false);
    };
    document.addEventListener("play", otherAudioStarted, true);
    window.addEventListener("pointerup", pointerEnded);
    window.addEventListener("pointercancel", pointerEnded);
    window.addEventListener("touchend", touchEnded, { passive: true });
    window.addEventListener("touchcancel", touchEnded, { passive: true });
    window.addEventListener("keyup", keyEnded);
    window.addEventListener("scrollend", scrollEnded, true);
    onCleanup(() => {
      playAttempt++;
      cancelReference(false);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      document.removeEventListener("play", otherAudioStarted, true);
      window.removeEventListener("scroll", dismissTooltip, true);
      window.removeEventListener("resize", dismissTooltip);
      window.removeEventListener("pointerup", pointerEnded);
      window.removeEventListener("pointercancel", pointerEnded);
      window.removeEventListener("touchend", touchEnded);
      window.removeEventListener("touchcancel", touchEnded);
      window.removeEventListener("keyup", keyEnded);
      window.removeEventListener("scrollend", scrollEnded, true);
      cancelSettling();
      stopPlaybackClock();
    });
  });
  const track = createMemo(() => analysis().tracks.find(item => item.label === trackLabel()) ?? analysis().tracks[0]);
  const notes = () => track()?.notes ?? [];
  const pianoRangeNotes = createMemo(() => analysis().tracks.flatMap(item => item.notes));
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
  const hasOutput = (label: string) => props.job.manifest?.some(item => item.label === label) ?? false;
  const hasVocals = () => recoveredVocals() || props.job.has_pitch_vocals;
  const hasSong = () => hasOutput("song") || props.job.has_original;
  const otherReferences = () => analysis().tracks.filter(item => item.label !== "vocals"
    && item.label !== "song" && item.label !== "instruments" && item.label !== "drums" && item.label !== "drums-vocals" && hasOutput(item.label));
  const initialTrack = track()?.label;
  const [reference, setReference] = createSignal(
    hasSong() ? "song"
      : initialTrack && hasOutput(initialTrack) && (initialTrack !== "vocals" || hasVocals())
        ? initialTrack : hasVocals() ? "vocals"
          : hasOutput("drums-vocals") ? "drums-vocals" : hasOutput("instruments") ? "instruments"
            : hasOutput("drums") ? "drums" : otherReferences()[0]?.label ?? "song",
  );
  const sourceClock = (label = reference()) => label === "song" && !hasOutput("song");
  const referenceUrl = (label = reference()) => {
    const url = label === "song"
      ? hasOutput("song") ? resultUrl(props.job.id, "song") : props.job.has_original ? originalUrl(props.job.id) : undefined
      : label === "vocals" ? pitchVocalsUrl(props.job.id)
        : resultUrl(props.job.id, label);
    return url ? playbackUrl(url) : undefined;
  };
  const referenceLabel = () => reference() === "song"
    ? hasOutput("song") ? "Transformed full song (not isolated vocals)" : "Original full song (unchanged, not isolated vocals)"
    : reference() === "vocals" ? `Just vocals (all vocal parts) · ${displayOutputLabel("vocals", props.job.options)}`
      : displayOutputLabel(reference() === "instruments" ? "Instruments" : reference() === "drums" ? "Drums only" : reference() === "drums-vocals" ? "Drums + Vocals" : reference(), props.job.options);
  const recoverVocals = async () => {
    setRecoveringVocals(true);
    setRecoveryError("");
    try {
      await recoverPitchVocals(props.job.id);
      setRecoveredVocals(true);
      changeReference("vocals");
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "Cached vocals could not be recovered.");
    } finally {
      setRecoveringVocals(false);
    }
  };
  const toAudioTime = (seconds: number, label = reference()) => sourceClock(label) ? seconds * analysis().tempo_percent / 100 : seconds;
  const fromAudioTime = (seconds: number, label = reference()) => sourceClock(label) ? seconds / (analysis().tempo_percent / 100) : seconds;
  const [activeSlot, setActiveSlot] = createSignal(0);
  const sources = [createSignal({ url: referenceUrl() }), createSignal<{ url: string | undefined }>({ url: undefined })] as const;
  const slots: HTMLAudioElement[] = [];
  let pending: { slot: number; label: string; phase: "loading" | "seeking" | "playing"; wasPlaying: boolean } | undefined;
  let nativeSeekPending = false;
  let internalSeekTime: number | null = null;
  const setAudioTime = (seconds: number) => {
    // Browsers may emit seeking even when assigning the current time.
    internalSeekTime = seconds;
    audio.currentTime = seconds;
  };
  const cancelReference = (restorePlayback = true) => {
    const previous = pending;
    pending = undefined;
    if (!previous) return;
    const discarded = slots[previous.slot];
    discarded.pause();
    discarded.removeAttribute("src");
    discarded.load();
    sources[previous.slot][1]({ url: undefined });
    if (restorePlayback && previous.wasPlaying && audio.paused
      && !Array.from(document.querySelectorAll("audio")).some(item => item !== audio && !item.paused)) {
      const old = audio;
      void old.play().catch(error => {
        if (audio === old) setPlaybackError(error instanceof Error ? error.message : "Playback could not be resumed.");
      });
    }
  };
  const referenceFailed = (candidate: NonNullable<typeof pending>, error: unknown) => {
    if (pending !== candidate) return;
    cancelReference();
    setReferenceError(error instanceof Error || error instanceof DOMException
      ? error.message : "This reference audio could not be played.");
  };
  const promoteReference = (candidate: NonNullable<typeof pending>) => {
    if (pending !== candidate) return;
    const previous = audio;
    const oldSlot = activeSlot();
    pending = undefined;
    playAttempt++;
    stopPlaybackClock();
    previous.pause();
    audio = slots[candidate.slot];
    audio.volume = previous.volume;
    audio.muted = previous.muted;
    setActiveSlot(candidate.slot);
    previous.removeAttribute("src");
    previous.load();
    sources[oldSlot][1]({ url: undefined });
    setReference(candidate.label);
    internalSeekTime = null;
    nativeSeekPending = false;
    setSeeking(false);
    setPlaybackError("");
    setReferenceError("");
    syncNativePlayback();
    updatePosition();
    if (!audio.paused) startPlaybackClock();
  };
  const prepareReference = (index: number) => {
    const candidate = pending;
    if (!candidate || candidate.slot !== index || candidate.phase === "playing") return;
    const target = slots[index];
    if (target.readyState < 1) return;
    const current = Math.max(0, Math.min(analysis().duration_s, fromAudioTime(audio.currentTime)));
    const requestedTime = toAudioTime(current, candidate.label);
    if (Number.isFinite(target.duration)
      && (requestedTime > target.duration || (!audio.paused && !audio.ended && requestedTime >= target.duration))) {
      referenceFailed(candidate, new Error("This background does not cover the current playback position."));
      return;
    }
    const targetTime = requestedTime;
    if (target.seeking) return;
    if (Math.abs(target.currentTime - targetTime) > 0.08) {
      candidate.phase = "seeking";
      try {
        target.currentTime = targetTime;
      } catch (error) {
        referenceFailed(candidate, error);
      }
      return;
    }
    if (target.readyState < (audio.paused || audio.ended ? 2 : 3)) return;
    target.volume = audio.volume;
    target.muted = audio.muted;
    if (audio.paused || audio.ended) {
      promoteReference(candidate);
      return;
    }
    candidate.phase = "playing";
    candidate.wasPlaying = true;
    void target.play().then(() => promoteReference(candidate), error => referenceFailed(candidate, error));
  };
  const changeReference = (label: string) => {
    cancelReference();
    if (label === reference()) return;
    const url = referenceUrl(label);
    if (!url) return;
    const slot = 1 - activeSlot();
    pending = { slot, label, phase: "loading", wasPlaying: false };
    setPlaybackError("");
    setReferenceError("");
    sources[slot][1]({ url });
    slots[slot].load();
  };
  const seek = (seconds: number) => {
    const next = Math.max(0, Math.min(analysis().duration_s, seconds));
    setSeekRevision(value => value + 1);
    if (audio && Math.abs(audio.currentTime - toAudioTime(next)) > 0.001) setSeeking(true);
    setPosition(next);
    if (audio) setAudioTime(toAudioTime(next));
  };
  let rulerGesture: { x: number; y: number; scrollLeft: number; moved: boolean } | undefined;
  const seekRuler = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
    const gesture = rulerGesture;
    rulerGesture = undefined;
    if (gesture && (gesture.moved || Math.abs(event.clientX - gesture.x) > 8
      || Math.abs(event.clientY - gesture.y) > 8 || viewport.scrollLeft !== gesture.scrollLeft)) return;
    // The ruler's rect moves with horizontal scrolling; the sticky note axis does not.
    if (event.clientX < viewport.getBoundingClientRect().left + viewport.clientLeft + AXIS_WIDTH) return;
    seek((event.clientX - event.currentTarget.getBoundingClientRect().left - AXIS_WIDTH) / zoom());
  };
  const togglePlayback = () => {
    if (!referenceUrl()) return;
    if (pending?.phase === "playing") {
      cancelReference(false);
      syncNativePlayback();
      return;
    }
    const attempt = ++playAttempt;
    if (!audio.paused) audio.pause();
    else {
      setReferenceError("");
      setPlaybackError("");
      void audio.play().catch((error: unknown) => {
        if (attempt !== playAttempt) return;
        // Native pause/load can interrupt a pending play without a media failure.
        if (error instanceof DOMException && error.name === "AbortError" && audio.paused) return;
        setPlaybackError(error instanceof Error || error instanceof DOMException
          ? error.message : "This reference audio could not be played.");
      });
    }
  };
  const togglePlaybackKey = (event: KeyboardEvent): boolean => {
    const target = event.target;
    const element = target instanceof Element ? target : null;
    if (event.key !== " " || event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.metaKey || event.altKey
      || (element instanceof HTMLElement && element.isContentEditable)
      || element?.closest("input, textarea, select, button, a, [contenteditable]:not([contenteditable='false']), [role='button'], .timeline-karaoke-pitches")
      || (element?.closest("[role='slider']") && !element.closest(".pitch-ruler"))) return false;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) togglePlayback();
    return true;
  };
  const seekRulerKey = (event: KeyboardEvent) => {
    if (togglePlaybackKey(event)) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? analysis().duration_s
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? position() + 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown" ? position() - 1
          : event.key === "PageUp" ? position() + 10 : event.key === "PageDown" ? position() - 10 : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    seek(next);
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
    if (viewport) moveViewport(center * next - viewport.clientWidth / 2 + AXIS_WIDTH);
  };
  createEffect(() => {
    track()?.label;
    dismissTooltip();
    setSelectedNote(null);
    setSelectedWord(null);
  });
  createEffect(() => {
    // Keep the typical vocal register visible without hiding high/low outliers.
    // All rows remain reachable by vertical scroll, including on short phones.
    const pitches = notes().map(note => note.midi).sort((left, right) => left - right);
    if (!viewport || pitches.length === 0) return;
    const middle = pitches[Math.floor(pitches.length / 2)];
    const rowCenter = 32 + (rows()[0] - middle + 0.5) * ROW_HEIGHT;
    const availableHeight = viewport.clientHeight - (analysis().word_alignment || analysis().words.length > 0 ? 64 : 0);
    moveViewport(viewport.scrollLeft, rowCenter - availableHeight / 2);
  });
  const updatePosition = () => {
    const next = fromAudioTime(audio.currentTime);
    setPosition(next);
    // Armed input alone is not movement (for example a subpixel wheel delta).
    // Observe pending physical movement before any auto-follow write.
    if (nativeSeekPending) {
      if (viewport) {
        const x = AXIS_WIDTH + next * zoom();
        moveViewport(x - viewport.clientWidth * 0.25);
      }
    } else if (follow() && !browsing() && !gestureActive() && !(userScroll && userScrolled) && !audio.paused && viewport) {
      const x = AXIS_WIDTH + next * zoom();
      const forwardBoundary = viewport.scrollLeft + AXIS_WIDTH + (viewport.clientWidth - AXIS_WIDTH) * 0.75;
      if (x > forwardBoundary || x < viewport.scrollLeft + AXIS_WIDTH) {
        moveViewport(x - AXIS_WIDTH - 30);
      }
    }
  };

  return (
    <section class="pitch-view" aria-label="Karaoke with pitches">
      <div class="pitch-heading">
        <h3 class="text-base font-semibold">Karaoke with pitches</h3>
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
        <div role="group" aria-label="Pitch background audio" aria-describedby={!hasOutput("instruments") || !hasOutput("drums") || !hasOutput("drums-vocals") ? backgroundHelpId : undefined}
          class="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <span>Background audio</span>
          <Button type="button" class="h-auto min-h-11 max-w-full whitespace-normal" variant={reference() === "song" ? "secondary" : "outline"} aria-pressed={reference() === "song"} disabled={!hasSong()} onClick={() => changeReference("song")}>Full song</Button>
          <Button type="button" class="h-auto min-h-11 max-w-full whitespace-normal" variant={reference() === "vocals" ? "secondary" : "outline"} aria-pressed={reference() === "vocals"} disabled={!hasVocals()} onClick={() => changeReference("vocals")}>Just vocals</Button>
          <Button type="button" class="h-auto min-h-11 max-w-full whitespace-normal" variant={reference() === "instruments" ? "secondary" : "outline"} aria-pressed={reference() === "instruments"} disabled={!hasOutput("instruments")} onClick={() => changeReference("instruments")}>{displayOutputLabel("Instruments", props.job.options)}</Button>
          <Button type="button" class="h-auto min-h-11 max-w-full whitespace-normal" variant={reference() === "drums" ? "secondary" : "outline"} aria-pressed={reference() === "drums"} disabled={!hasOutput("drums")} onClick={() => changeReference("drums")}>{displayOutputLabel("Drums only", props.job.options)}</Button>
          <Button type="button" class="h-auto min-h-11 max-w-full whitespace-normal" variant={reference() === "drums-vocals" ? "secondary" : "outline"} aria-pressed={reference() === "drums-vocals"} disabled={!hasOutput("drums-vocals")} onClick={() => changeReference("drums-vocals")}>{displayOutputLabel("Drums + Vocals", props.job.options)}</Button>
          <For each={otherReferences()}>{item => <Button type="button" class="h-auto min-h-11 max-w-full whitespace-normal" variant={reference() === item.label ? "secondary" : "outline"} aria-pressed={reference() === item.label} onClick={() => changeReference(item.label)}>{displayOutputLabel(item.label, props.job.options)}</Button>}</For>
        </div>
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
      <Show when={!hasOutput("instruments") || !hasOutput("drums") || !hasOutput("drums-vocals")}>
        <p id={backgroundHelpId} class="text-xs text-muted-foreground">Only generated audio is available in this job. Select “Extract instruments” for instruments or “Split drums, bass &amp; other instruments” together with pitch analysis for drums and the drums-and-vocals mix.</p>
      </Show>
      <Show when={!hasVocals()}>
        <p class="text-xs text-muted-foreground">This stored job has no vocal listening reference. Recover its already-computed vocals from the cache without rerunning analysis.</p>
        <Show when={props.job.has_original} fallback={<p class="text-xs text-muted-foreground">The original audio is unavailable, so cached vocals cannot be recovered.</p>}>
          <Button type="button" variant="outline" disabled={recoveringVocals()} onClick={recoverVocals}>
            {recoveringVocals() ? "Recovering cached vocals…" : "Recover cached vocals"}
          </Button>
        </Show>
        <Show when={recoveryError()}><p role="alert" class="text-sm text-destructive">{recoveryError()}</p></Show>
      </Show>
      <Show when={sourceClock() && analysis().tempo_percent !== 100}>
        <p class="text-xs text-muted-foreground">Original-speed playback uses its original clock, mapped to the output timeline. Select Just vocals for matching transformed playback when available.</p>
      </Show>
      <p class="text-xs text-muted-foreground">Swipe or scroll horizontally; zoom for short notes. Tap the time ruler to seek, or tap a note to seek and inspect it. Focus the ruler and use arrow keys (1 second), Page Up/Down (10 seconds), or Home/End. Playback position: {timeLabel(position())} (output time).</p>
      <Show when={analysis().word_alignment || analysis().words.length > 0}>
        <p class="pitch-alignment-notice">{`${analysis().word_alignment === "torchaudio/MMS_FA" ? "Approximate MMS acoustic word alignment from full vocals, not exact syllable timing; reference-aligned words are not verified lyrics. Uncorroborated provider words have no word links. Acoustic alignment scores are not calibrated correctness probabilities." : analysis().word_alignment === "whisper-approximate" ? "Approximate Whisper word alignment from full vocals, not exact syllable timing or independent recognition of split voices." : "Stored approximate word timings; the alignment model is unspecified, not inferred from these values."} Words below the notes may be wrong or misaligned. Select a word to highlight its linked notes; one word can span several notes (melisma).`}</p>
      </Show>
      <Show when={analysis().word_alignment && analysis().words.length === 0}>
        <p class="text-sm text-muted-foreground">No sung words were recognized; pitch notes remain available.</p>
      </Show>
      <Show when={!analysis().word_alignment && analysis().words.length === 0}>
        <p class="text-xs text-muted-foreground">Request lyrics together with pitch to add approximate sung-word associations.</p>
      </Show>
      <Show when={notes().length > 0} fallback={<p role="status" class="text-sm text-muted-foreground">No confident voiced notes detected in this stem.</p>}>
        <div ref={viewport} class="pitch-viewport" tabIndex={0} role="region" aria-label="Scrollable vocal melody timeline" aria-keyshortcuts="Space"
          onScroll={onTimelineScroll}
          onPointerDown={event => { activePointer = event.pointerId; armUserScroll(); }}
          onTouchStart={() => { touching = true; armUserScroll(); }}
          onWheel={event => {
            if (event.ctrlKey || event.defaultPrevented) {
              if (!userScrolled && !gestureActive()) userScroll = false;
              return;
            }
            const dx = event.shiftKey ? event.deltaY : event.deltaX;
            const dy = event.shiftKey ? 0 : event.deltaY;
            if ((dx < 0 && viewport.scrollLeft > 0) || (dx > 0 && viewport.scrollLeft < viewport.scrollWidth - viewport.clientWidth)
              || (dy < 0 && viewport.scrollTop > 0) || (dy > 0 && viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight)) armUserScroll();
          }}
          onKeyDown={event => {
            if (togglePlaybackKey(event)) return;
            if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key.startsWith("Arrow") || ["PageUp", "PageDown", "Home", "End"].includes(event.key)) {
              heldScrollKeys.add(event.key);
              armUserScroll();
            }
          }}>
          <div class="pitch-canvas" style={{ width: `${width() + AXIS_WIDTH}px` }}>
            <div class="pitch-ruler" style={{ width: `${width() + AXIS_WIDTH}px` }}
              role="slider" tabIndex={0} aria-label="Pitch timeline position" aria-orientation="horizontal" aria-keyshortcuts="Space"
              aria-valuemin={0} aria-valuemax={analysis().duration_s} aria-valuenow={position()}
              aria-valuetext={`${timeLabel(position())} output time`}
              onClick={seekRuler} onKeyDown={seekRulerKey}
              onPointerDown={event => {
                rulerGesture = { x: event.clientX, y: event.clientY, scrollLeft: viewport.scrollLeft, moved: event.button !== 0 };
              }}
              onPointerMove={event => {
                if (rulerGesture && (Math.abs(event.clientX - rulerGesture.x) > 8 || Math.abs(event.clientY - rulerGesture.y) > 8)) rulerGesture.moved = true;
              }}
              onPointerCancel={() => { if (rulerGesture) rulerGesture.moved = true; }}>
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
                    aria-describedby={tooltip()?.key === note ? tooltipId : undefined}
                    onPointerEnter={event => showNoteTooltip(event.currentTarget, note)} onPointerLeave={dismissTooltip}
                    onPointerMove={event => { if ((event.pointerType === "mouse" || event.pointerType === "pen") && tooltip()?.key !== note) showNoteTooltip(event.currentTarget, note); }}
                    onFocus={event => showNoteTooltip(event.currentTarget, note)} onBlur={dismissTooltip}
                    onClick={event => { selectNote(note); showNoteTooltip(event.currentTarget, note); }}
                    onKeyDown={event => {
                      if (event.key === "Escape") dismissTooltip();
                      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNote(note); }
                    }}>
                    <rect x={x()} y={y()} width={noteWidth()} height={ROW_HEIGHT - 4} rx="3" />
                    <text x={x() + noteWidth() / 2} y={y() + 14} text-anchor="middle" font-size="12"
                      textLength={Math.min(note.note.length * 7.2, Math.max(1, noteWidth() - 2))} lengthAdjust="spacingAndGlyphs">{note.note}</text>
                  </g>;
                }}</For>
                <line x1={position() * zoom()} x2={position() * zoom()} y1="0" y2={pitchHeight()} class="pitch-playhead" />
              </svg>
            </div>
            <Show when={analysis().word_alignment || analysis().words.length > 0}>
              <div class="pitch-words" style={{ width: `${width() + AXIS_WIDTH}px` }} aria-label="Approximate sung words">
                <span class="pitch-word-label">Words<br /><small>≈ timing</small></span>
                <For each={analysis().words}>{(word, index) => {
                  const firstLinked = createMemo(() => notes().find(note => note.word_indices.includes(index())));
                  return <button type="button" class="pitch-word" classList={{ "pitch-word-selected": selectedWord() === index() || (selectedNote()?.word_indices.includes(index()) ?? false), "pitch-word-unlinked": firstLinked() === undefined }}
                    style={{ left: `${AXIS_WIDTH + word.start_s * zoom()}px`, width: `${Math.max(4, (word.end_s - word.start_s) * zoom())}px` }}
                    aria-label={`${word.origin === "asr-extra" ? "ASR-only extra: " : ""}${word.text}, approximate word timing`}
                    aria-describedby={tooltip()?.key === word ? tooltipId : undefined}
                    onPointerEnter={event => showTooltip(event.currentTarget, word, word.text)} onPointerLeave={dismissTooltip}
                    onPointerMove={event => { if ((event.pointerType === "mouse" || event.pointerType === "pen") && tooltip()?.key !== word) showTooltip(event.currentTarget, word, word.text); }}
                    onFocus={event => showTooltip(event.currentTarget, word, word.text)} onBlur={dismissTooltip}
                    onKeyDown={event => { if (event.key === "Escape") dismissTooltip(); }}
                    onClick={event => {
                      setSelectedWord(index()); setSelectedNote(null); seek(firstLinked()?.start_s ?? word.start_s);
                      showTooltip(event.currentTarget, word, word.text);
                    }}>
                    {word.text}
                  </button>;
                }}</For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={tooltip()}>{content => <Portal>
        <div id={tooltipId} role="tooltip" class="pitch-tooltip"
          style={{ left: `${content().x}px`, top: `${content().y}px`, transform: `translate(-50%, ${content().below ? "0" : "-100%"})` }}>
          <Show when={content().note}><div class="pitch-tooltip-note">{content().note}</div></Show>
          <Show when={content().lyrics}><div class="pitch-tooltip-lyrics">{content().lyrics}</div></Show>
        </div>
      </Portal>}</Show>
      <div class="pitch-selection" aria-live="polite">
        <Show when={selectedNote()} fallback={<Show when={selectedWord() === null}><span>Select a note or word for details.</span></Show>}>{note => <>
          <strong>{note().note}</strong> · {note().cents >= 0 ? "+" : ""}{note().cents} cents · {note().frequency_hz.toFixed(1)} Hz · {timeLabel(note().start_s)}–{timeLabel(note().end_s)} · confidence {Math.round(note().confidence * 100)}%
          <Show when={note().word_indices.length > 0}><span> · Approximate words: {note().word_indices.map(index => analysis().words[index].text).join(" ")}</span></Show>
        </>}</Show>
        <Show when={selectedWord() !== null}><span>“{analysis().words[selectedWord()!].text}” · approximate full-vocal word alignment.</span></Show>
      </div>
      <footer class="pitch-footer">
        <div class="pitch-skip-controls" role="group" aria-label="Timeline playback">
          <Button type="button" variant="outline" aria-label="Back 5 seconds" onClick={() => seek(position() - 5)}>−5 s</Button>
          <Button type="button" variant="outline" aria-label={nativePaused() ? "Play" : "Pause"} disabled={!referenceUrl()} onClick={togglePlayback}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
              <Show when={nativePaused()} fallback={<><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>}>
                <path d="M7 3v18l15-9z" />
              </Show>
            </svg>
          </Button>
          <Button type="button" variant="outline" aria-label="Forward 5 seconds" onClick={() => seek(position() + 5)}>+5 s</Button>
        </div>
        <p class="pitch-follow-status" role="status">
          <Show when={follow() && browsing()}>Auto-follow paused while browsing. Scroll back to the playhead to resume.</Show>
        </p>
        <Show when={playbackError()}><p role="alert" class="text-sm text-destructive">{playbackError()}</p></Show>
        <Show when={referenceError()}><p role="alert" class="text-sm text-destructive">{referenceError()}</p></Show>
        <TimelineKaraoke job={props.job} position={position()} notes={notes()} playing={!nativePaused()} seeking={seeking()} seekRevision={seekRevision()} onKeyDown={togglePlaybackKey} />
        <For each={[0, 1]}>{index => <Show when={sources[index][0]()} keyed>{source =>
          <audio ref={element => { slots[index] = element; if (index === 0 && !audio) audio = element; }}
            aria-label={`Pitch reference: ${referenceLabel()}`} controls={activeSlot() === index}
            hidden={activeSlot() !== index} preload={activeSlot() === index ? "none" : "auto"}
            style={{ display: activeSlot() === index ? "block" : "none" }} class="w-full" src={source.url}
            onSeeking={event => {
              if (event.currentTarget !== audio) return;
              setSeeking(true);
              setSeekRevision(value => value + 1);
              nativeSeekPending = internalSeekTime === null || Math.abs(audio.currentTime - internalSeekTime) > 0.01;
              if (nativeSeekPending) internalSeekTime = null;
            }}
            onPlay={event => {
              if (event.currentTarget !== audio) return;
              if (pending?.phase === "playing") cancelReference(false);
              startPlaybackClock();
            }}
            onPause={event => { if (event.currentTarget === audio) stopPlaybackClock(); }}
            onEnded={event => { if (event.currentTarget === audio) stopPlaybackClock(); }}
            onEmptied={event => { if (event.currentTarget === audio) stopPlaybackClock(); }}
            onError={event => {
              if (event.currentTarget !== slots[index]) return;
              if (event.currentTarget === audio) {
                stopPlaybackClock();
                setPlaybackError(audio.error?.message || "This reference audio could not be played.");
              } else if (pending?.slot === index) referenceFailed(pending, new Error(event.currentTarget.error?.message || "This reference audio could not be played."));
            }}
            onLoadedMetadata={event => { if (event.currentTarget === slots[index]) prepareReference(index); }}
            onCanPlay={event => { if (event.currentTarget === slots[index]) prepareReference(index); }}
            onTimeUpdate={event => { if (event.currentTarget === audio) updatePosition(); }}
            onSeeked={event => {
              if (event.currentTarget === audio) {
                updatePosition();
                nativeSeekPending = false;
                internalSeekTime = null;
                setSeeking(false);
              } else if (event.currentTarget === slots[index]) prepareReference(index);
            }} />
        }</Show>}</For>
        <PianoKeyboard notes={notes()} rangeNotes={pianoRangeNotes()} position={position()} playing={!nativePaused()} />
      </footer>
    </section>
  );
};

// History/current-job navigation reuses the parent view. Keep every playback,
// recovery and inspection state local to one job, not one component lifetime.
const PitchView: Component<{ job: JobDTO }> = (props) => (
  <Show when={props.job.id} keyed>{(_id) => <PitchTimeline job={props.job} />}</Show>
);

export default PitchView;
