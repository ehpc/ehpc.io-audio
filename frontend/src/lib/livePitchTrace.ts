// One cell per 50 ms of output time; repeated takes replace cells in place.
const CELLS_PER_SECOND = 20;
const MAX_CONTINUOUS_STEP = 0.5;

interface PreviousSample {
  time: number;
  pitch: number | null;
  firstWritten: number | null;
}

export class LivePitchTrace {
  private readonly pitches: Float32Array;
  private readonly joins: Uint8Array;
  private previous: PreviousSample | undefined;

  constructor(duration: number) {
    this.pitches = new Float32Array(Math.max(1, Math.ceil(duration * CELLS_PER_SECOND) + 1));
    this.pitches.fill(NaN);
    this.joins = new Uint8Array(this.pitches.length);
  }

  break() { this.previous = undefined; }

  sample(time: number, pitch: number | null): boolean {
    if (!Number.isFinite(time) || time < 0 || time * CELLS_PER_SECOND >= this.pitches.length) {
      this.break();
      return false;
    }
    const previous = this.previous;
    if (previous && time === previous.time) return false;
    this.previous = { time, pitch, firstWritten: null };
    if (!previous || time < previous.time) return false;
    const first = Math.floor(previous.time * CELLS_PER_SECOND);
    const last = Math.floor(time * CELLS_PER_SECOND);
    if (time - previous.time > MAX_CONTINUOUS_STEP) {
      // Playback advanced without measurements: erase only the visited span,
      // leave it unvoiced, and start a disconnected point at the new sample.
      this.pitches.fill(NaN, first, last + 1);
      this.joins.fill(0, first, Math.min(last + 2, this.joins.length));
      if (pitch !== null) this.pitches[last] = pitch;
      this.previous.firstWritten = last;
      return true;
    }
    this.previous.firstWritten = previous.firstWritten ?? first;
    for (let i = first; i <= last; i++) {
      // Silence erases the visited interval, but does not erase its future.
      const value = pitch === null ? NaN : previous.pitch === null ? (i === last ? pitch : NaN)
        : previous.pitch + (pitch - previous.pitch) * Math.max(0, Math.min(1, (i / CELLS_PER_SECOND - previous.time) / (time - previous.time)));
      this.pitches[i] = value;
      this.joins[i] = Number(i > first && Number.isFinite(value) && Number.isFinite(this.pitches[i - 1]));
    }
    if (previous.firstWritten !== null && first > previous.firstWritten && previous.pitch !== null && pitch !== null && Number.isFinite(this.pitches[first - 1])) {
      this.joins[first] = 1;
    }
    if (last + 1 < this.joins.length) this.joins[last + 1] = 0;
    return true;
  }

  path(start: number, end: number, zoom: number, topMidi: number, rowHeight: number): string {
    const first = Math.max(0, Math.floor(start * CELLS_PER_SECOND) - 1);
    const last = Math.min(this.pitches.length - 1, Math.ceil(end * CELLS_PER_SECOND) + 1);
    const parts: string[] = [];
    let preceding = false;
    for (let i = first; i <= last; i++) {
      const pitch = this.pitches[i];
      if (!Number.isFinite(pitch)) { preceding = false; continue; }
      const x = (i / CELLS_PER_SECOND - start) * zoom;
      const y = (topMidi - pitch + 0.5) * rowHeight;
      parts.push(`${preceding && this.joins[i] ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`);
      preceding = true;
    }
    return parts.join(' ');
  }
}
