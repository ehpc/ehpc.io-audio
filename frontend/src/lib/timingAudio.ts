import { registerMediaSession } from "./mediaSession";
import { FULL_TIMING_LEVEL, timingWindows, type TimingSelection, type TimingHintLevel } from "./timingPractice";
import type { KaraokeTiming } from "./karaoke";

const MAX_DRIFT = 0.08;
export const DEFAULT_TIMING_VOLUME = 75;

/** A native instrument master and an independently muted native vocal stream. */
export class TimingAudio {
  private readonly vocal = document.createElement("audio");
  private readonly abort = new AbortController();
  private owner?: HTMLAudioElement;
  private unregister?: () => void;
  private disposed = false;
  private starting = false;
  private operation = 0;
  private waiting = false;
  private waitingPosition = 0;
  private pageHidden = false;
  private timer: number | undefined;
  private nextBoundary: number | undefined;
  private windows: KaraokeTiming[] = [];
  private level: TimingHintLevel = FULL_TIMING_LEVEL;
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private readonly source: MediaElementAudioSourceNode;

  constructor(
    private readonly lines: readonly KaraokeTiming[],
    private readonly selection: TimingSelection,
    private readonly onError: (error: unknown) => void,
  ) {
    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.gain.gain.value = DEFAULT_TIMING_VOLUME / 100;
    this.source = this.context.createMediaElementSource(this.vocal);
    this.source.connect(this.gain).connect(this.context.destination);
    void this.context.resume().catch(error => this.fail(error));
    this.vocal.hidden = true;
    this.vocal.muted = true;
    this.vocal.preload = "auto";
    document.body.append(this.vocal);
  }

  private sparseHidden() {
    return (document.hidden || this.pageHidden) && this.level > 0 && this.level < FULL_TIMING_LEVEL;
  }

  private silence() {
    this.vocal.muted = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.nextBoundary = undefined;
  }

  private fail(error: unknown) {
    if (this.disposed) return;
    this.silence();
    this.owner?.pause();
    this.vocal.pause();
    this.onError(error);
  }

  private waitFor(element: HTMLMediaElement, ready: () => boolean, events: string[]): Promise<void> {
    if (this.abort.signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (element.error) return Promise.reject(new Error("The timing practice audio could not be loaded."));
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { if (ready()) { cleanup(); resolve(); } };
      const failed = () => { cleanup(); reject(new Error("The timing practice audio could not be loaded.")); };
      const cancelled = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
      const cleanup = () => {
        for (const event of events) element.removeEventListener(event, done);
        element.removeEventListener("error", failed);
        this.abort.signal.removeEventListener("abort", cancelled);
      };
      for (const event of events) element.addEventListener(event, done);
      element.addEventListener("error", failed);
      this.abort.signal.addEventListener("abort", cancelled, { once: true });
      done();
    });
  }

  async prepare(owner: HTMLAudioElement, url: string): Promise<void> {
    this.owner = owner;
    this.unregister = registerMediaSession(owner, this.vocal);
    const signal = this.abort.signal;
    owner.addEventListener("pause", this.onPause, { signal });
    owner.addEventListener("seeking", this.onSeeking, { signal });
    owner.addEventListener("seeked", this.onSeeked, { signal });
    owner.addEventListener("waiting", this.onWaiting, { signal });
    owner.addEventListener("playing", this.onPlaying, { signal });
    owner.addEventListener("ratechange", this.onRate, { signal });
    owner.addEventListener("volumechange", this.onVolume, { signal });
    owner.addEventListener("ended", this.onPause, { signal });
    this.vocal.addEventListener("error", this.onVocalError, { signal });
    this.vocal.addEventListener("seeked", this.onVocalSeeked, { signal });
    document.addEventListener("visibilitychange", this.onVisibility, { signal });
    window.addEventListener("pagehide", this.onPageHide, { signal });
    window.addEventListener("pageshow", this.onVisibility, { signal });
    this.vocal.src = url;
    this.vocal.load();
    try {
      await Promise.all([
        this.waitFor(owner, () => owner.readyState >= 2, ["loadeddata", "canplay"]),
        this.waitFor(this.vocal, () => this.vocal.readyState >= 2, ["loadeddata", "canplay"]),
      ]);
      if (!this.disposed) await this.align();
    } catch (error) {
      if (!this.disposed) { this.fail(error); throw error; }
    }
  }

  private async align(): Promise<void> {
    const owner = this.owner;
    if (!owner || this.disposed) return;
    this.silence();
    this.vocal.pause();
    this.vocal.playbackRate = owner.playbackRate;
    this.vocal.volume = owner.volume;
    if (Number.isFinite(this.vocal.duration) && owner.currentTime > this.vocal.duration) throw new Error("Vocals do not cover the current playback position.");
    if (Math.abs(this.vocal.currentTime - owner.currentTime) > 0.01) {
      this.vocal.currentTime = owner.currentTime;
      await this.waitFor(this.vocal, () => !this.vocal.seeking, ["seeked"]);
    }
  }

  /** Starts both native elements directly in the user's playback gesture. */
  async play(): Promise<void> {
    const owner = this.owner;
    if (!owner || this.disposed || this.starting) return;
    const resumed = this.context.resume();
    const operation = ++this.operation;
    this.starting = true;
    this.silence();
    try {
      this.vocal.playbackRate = owner.playbackRate;
      this.vocal.volume = owner.volume;
      if (Math.abs(this.vocal.currentTime - owner.currentTime) > 0.01) this.vocal.currentTime = owner.currentTime;
      const master = owner.play();
      const vocal = this.vocal.play();
      await Promise.all([master, vocal, resumed]);
      if (this.disposed || operation !== this.operation || owner.paused || owner.seeking || this.sparseHidden()) {
        if (this.disposed || owner.paused || this.sparseHidden()) this.vocal.pause();
        return;
      }
      this.tick();
    } catch (error) {
      if (!this.disposed && operation === this.operation) { this.fail(error); throw error; }
    } finally { if (operation === this.operation) this.starting = false; }
  }

  setVolume(volume: number) {
    this.gain.gain.value = volume;
  }

  setLevel(level: TimingHintLevel) {
    this.level = level;
    this.windows = timingWindows(this.lines, this.selection, level);
    this.silence();
    if (this.sparseHidden()) this.onPageHide();
    else if (this.owner && !this.owner.paused && this.vocal.paused) void this.resumeAligned();
    else this.tick();
  }

  /** Called by the existing playback frame; the timer only wakes at the next boundary. */
  tick() {
    const owner = this.owner;
    if (!owner || this.disposed || owner.paused || owner.ended || owner.seeking) return;
    if (this.sparseHidden()) { this.silence(); this.vocal.pause(); return; }
    // WebKit can advance the media clock at HAVE_CURRENT_DATA without another playing event.
    if (this.waiting && this.vocal.paused && !this.starting && owner.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && owner.currentTime > this.waitingPosition + 0.005) {
      this.waiting = false;
      void this.resumeAligned();
      return;
    }
    if (this.vocal.paused || this.vocal.seeking) return;
    if (Math.abs(owner.currentTime - this.vocal.currentTime) > MAX_DRIFT) {
      this.silence();
      try { this.vocal.currentTime = owner.currentTime; }
      catch (error) { this.fail(error); }
      return;
    }
    const position = owner.currentTime;
    let audible = this.level === FULL_TIMING_LEVEL;
    let next: number | undefined;
    if (this.level > 0 && this.level < FULL_TIMING_LEVEL) {
      for (const window of this.windows) {
        if (window.end_s <= position) continue;
        if (position >= window.start_s) { audible = true; next = window.end_s; }
        else next = window.start_s;
        break;
      }
    }
    const muted = owner.muted || !audible;
    if (this.vocal.muted !== muted) this.vocal.muted = muted;
    if (next !== this.nextBoundary) {
      clearTimeout(this.timer);
      this.nextBoundary = next;
      this.timer = next === undefined ? undefined : window.setTimeout(() => {
        this.timer = undefined;
        this.nextBoundary = undefined;
        this.tick();
      }, Math.max(0, (next - position) * 1000 / owner.playbackRate));
    }
  }

  private onPause = () => { this.operation++; this.starting = false; this.waiting = false; this.silence(); this.vocal.pause(); };
  private onSeeking = () => { this.operation++; this.starting = false; this.waiting = false; this.silence(); this.vocal.pause(); };
  private onSeeked = () => {
    if (this.owner?.paused) void this.align().catch(error => { if (!this.disposed) this.fail(error); });
    else void this.resumeAligned();
  };
  private onWaiting = () => { this.operation++; this.starting = false; this.waiting = true; this.waitingPosition = this.owner?.currentTime ?? 0; this.silence(); this.vocal.pause(); };
  private onPlaying = () => { this.waiting = false; if (!this.starting) void this.resumeAligned(); };
  private onRate = () => { this.silence(); this.vocal.playbackRate = this.owner?.playbackRate ?? 1; this.tick(); };
  private onVolume = () => { if (this.owner) this.vocal.volume = this.owner.volume; this.silence(); this.tick(); };
  private onVocalError = () => this.fail(new Error("The timing practice vocals could not be played."));
  private onVocalSeeked = () => this.tick();
  private onPageHide = () => {
    this.pageHidden = true;
    if (this.level > 0 && this.level < FULL_TIMING_LEVEL) {
      this.operation++;
      this.starting = false;
      this.silence();
      this.vocal.pause();
    }
  };
  private onVisibility = () => {
    if (document.hidden) this.onPageHide();
    else {
      this.pageHidden = false;
      if (this.owner && !this.owner.paused && this.vocal.paused) void this.resumeAligned();
    }
  };

  private async resumeAligned() {
    const owner = this.owner;
    if (!owner || owner.paused || owner.seeking || this.disposed || this.starting || this.sparseHidden()) return;
    const operation = ++this.operation;
    this.starting = true;
    try {
      await this.align();
      if (this.disposed || operation !== this.operation || owner.paused || owner.seeking || this.sparseHidden()) return;
      await this.vocal.play();
      if (this.disposed || operation !== this.operation || owner.paused || owner.seeking || this.sparseHidden()) {
        if (this.disposed || owner.paused || this.sparseHidden()) this.vocal.pause();
        return;
      }
      this.tick();
    } catch (error) { if (!this.disposed && operation === this.operation) this.fail(error); }
    finally { if (operation === this.operation) this.starting = false; }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.operation++;
    this.silence();
    this.abort.abort();
    this.source.disconnect();
    this.gain.disconnect();
    void this.context.close();
    this.vocal.pause();
    this.vocal.removeAttribute("src");
    this.vocal.load();
    this.unregister?.();
    this.vocal.remove();
  }
}
