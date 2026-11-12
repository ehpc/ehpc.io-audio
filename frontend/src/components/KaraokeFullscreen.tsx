import { Show, createEffect, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { JobDTO, PitchNoteDTO } from "~/api";
import { Button } from "~/components/button";
import TimelineKaraoke from "./TimelineKaraoke";

interface KaraokeFullscreenProps {
  job: JobDTO;
  position: number;
  mediaPosition: number;
  mediaDuration: number;
  notes: PitchNoteDTO[];
  playing: boolean;
  seeking: boolean;
  seekRevision: number;
  fontSize: number;
  onFontSize: (size: number) => void;
  showPitches: boolean;
  onShowPitches: (show: boolean) => void;
  background: JSX.Element;
  activeSource: string;
  transport: JSX.Element;
  error: string;
  onSeek: (seconds: number) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  returnFocus: HTMLElement | null;
  onClose: () => void;
}

function clock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export default function KaraokeFullscreen(props: KaraokeFullscreenProps) {
  let dialog!: HTMLElement;
  let close!: HTMLButtonElement;
  let background!: HTMLDivElement;
  let previousOverflow = "";
  let previousX = 0;
  let previousY = 0;
  onMount(() => {
    previousOverflow = document.body.style.overflow;
    previousX = window.scrollX;
    previousY = window.scrollY;
    document.body.style.overflow = "hidden";
    close.focus({ preventScroll: true });
  });
  onCleanup(() => {
    document.body.style.overflow = previousOverflow;
    if (window.scrollX !== previousX || window.scrollY !== previousY) window.scrollTo(previousX, previousY);
    queueMicrotask(() => { if (props.returnFocus?.isConnected) props.returnFocus.focus({ preventScroll: true }); });
  });
  createEffect(() => {
    props.activeSource;
    queueMicrotask(() => {
      if (!background?.isConnected) return;
      const row = background.querySelector<HTMLElement>('[role="group"]');
      const active = row?.querySelector<HTMLElement>('button[aria-pressed="true"]');
      if (!row || !active) return;
      const outer = row.getBoundingClientRect(), item = active.getBoundingClientRect();
      if (item.left < outer.left) row.scrollLeft += item.left - outer.left;
      else if (item.right > outer.right) row.scrollLeft += item.right - outer.right;
    });
  });
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    props.onKeyDown(event);
  };
  return <Portal>
    <section ref={dialog} class="karaoke-fullscreen" role="dialog" aria-modal="true" aria-label="Karaoke fullscreen" onKeyDown={keyDown}>
      <header class="karaoke-fullscreen-header">
        <h2>Karaoke</h2>
        <Button ref={close} type="button" variant="outline" aria-label="Exit karaoke fullscreen" onClick={props.onClose}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </Button>
      </header>
      <div ref={background} class="karaoke-fullscreen-background">{props.background}</div>
      <Show when={props.error}><p role="alert" class="text-sm text-destructive">{props.error}</p></Show>
      <div class="karaoke-fullscreen-reader">
        <TimelineKaraoke job={props.job} position={props.position} notes={props.notes} playing={props.playing}
          seeking={props.seeking} seekRevision={props.seekRevision} fontSize={props.fontSize} onFontSize={props.onFontSize}
          showPitches={props.showPitches} onShowPitches={props.onShowPitches} fit />
      </div>
      <div class="karaoke-fullscreen-player">
        <label class="karaoke-fullscreen-seek">
          <span>{clock(props.mediaPosition)}</span>
          <input type="range" aria-label="Karaoke playback position" min="0" max={props.mediaDuration} step="0.01"
            value={Math.min(props.mediaPosition, props.mediaDuration)} style={{ "--karaoke-seek-progress": `${props.mediaDuration > 0 ? Math.max(0, Math.min(100, props.mediaPosition / props.mediaDuration * 100)) : 0}%` }}
            onInput={event => props.onSeek(event.currentTarget.valueAsNumber)} />
          <span>{clock(props.mediaDuration)}</span>
        </label>
        {props.transport}
      </div>
    </section>
  </Portal>;
}
