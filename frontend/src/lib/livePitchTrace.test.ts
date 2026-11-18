import { describe, expect, it } from 'vitest';
import { LivePitchTrace } from './livePitchTrace';

function take(trace: LivePitchTrace, from: number, to: number, pitch: number | null) {
  for (let i = Math.round(from * 20); i <= Math.round(to * 20); i++) trace.sample(i / 20, pitch);
}
function points(trace: LivePitchTrace) {
  return [...trace.path(0, 10, 100, 72, 24).matchAll(/([ML])(-?\d+\.\d+) (-?\d+\.\d+)/g)]
    .map(([, command, x, y]) => ({ command, time: Number(x) / 100, y: Number(y) }));
}

describe('live pitch history', () => {
  it('preserves untouched history across seeks, and replaces only sung or silent visited spans', () => {
    const trace = new LivePitchTrace(10);
    take(trace, 0, 5, 60.25);
    const original = points(trace);
    trace.break(); // A seek by itself never clears anything.
    expect(points(trace)).toEqual(original);
    take(trace, 1, 1.5, null);
    const silent = points(trace);
    expect(silent.some(p => p.time === 0.5)).toBe(true);
    expect(silent.some(p => p.time === 1.25)).toBe(false);
    expect(silent.find(p => p.time === 1.55)?.command).toBe('M');
    expect(silent.find(p => p.time === 4)?.y).toBe(original.find(p => p.time === 4)?.y);
    trace.break();
    take(trace, 2, 2.5, 62.5);
    const replaced = points(trace);
    expect(replaced.find(p => p.time === 2.25)?.y).toBe((72 - 62.5 + 0.5) * 24);
    expect(replaced.find(p => p.time === 2)?.command).toBe('M');
    expect(replaced.find(p => p.time === 2.55)?.command).toBe('M');
    expect(replaced.find(p => p.time === 4)?.y).toBe(original.find(p => p.time === 4)?.y);
    trace.break(); // Mic off or forward seek, with no samples.
    expect(points(trace)).toEqual(replaced);
  });

  it('leaves gaps at silence and discontinuities and keeps fractional MIDI geometry', () => {
    const trace = new LivePitchTrace(10);
    take(trace, 0, 0.5, 60.25);
    take(trace, 0.55, 0.75, null);
    take(trace, 0.8, 1, 60.75);
    trace.break();
    take(trace, 3, 3.25, 61);
    const result = points(trace);
    expect(result.find(p => p.time === 0.25)?.y).toBe((72 - 60.25 + 0.5) * 24);
    expect(result.some(p => p.time === 0.65)).toBe(false);
    expect(result.find(p => p.time === 0.8)?.command).toBe('M');
    expect(result.find(p => p.time === 3)?.command).toBe('M');
  });

  it('does not reconnect to an old take when several ticks land in one bin after a seek', () => {
    const trace = new LivePitchTrace(10);
    take(trace, 0, 3, 60);
    trace.break();
    trace.sample(1.001, 62);
    trace.sample(1.01, 62);
    trace.sample(1.02, 62);
    trace.sample(1.08, 62);
    expect(points(trace).find(p => p.time === 1)?.command).toBe('M');
  });

  it('replaces an unmeasured advancing interval with a gap without treating a seek as playback', () => {
    const trace = new LivePitchTrace(10);
    take(trace, 0, 5, 60);
    const original = points(trace);
    trace.break();
    trace.sample(1, 62);
    expect(points(trace)).toEqual(original);
    trace.sample(1.5, 62); // Exactly the continuous-step boundary.
    expect(points(trace).find(p => p.time === 1.25)?.y).toBe((72 - 62 + 0.5) * 24);
    trace.sample(2.25, 63); // Playback advanced, but there were no analyses.
    const result = points(trace);
    expect(result.some(p => p.time === 1.75)).toBe(false);
    expect(result.find(p => p.time === 2.25)?.command).toBe('M');
    expect(result.find(p => p.time === 2.3)?.command).toBe('M');
    expect(result.find(p => p.time === 4)?.y).toBe(original.find(p => p.time === 4)?.y);
    trace.break();
    trace.sample(4.5, 65); // Explicit seek is not an advancing interval.
    expect(points(trace)).toEqual(result);
  });

  it('keeps only the latest take in visited cells and retains untouched future', () => {
    const trace = new LivePitchTrace(6);
    take(trace, 0, 5, 70);
    for (let i = 0; i < 200; i++) { trace.break(); take(trace, 1, 3, 55 + i % 10); }
    const result = points(trace);
    expect(result.find(p => p.time === 2)?.y).toBe((72 - 64 + 0.5) * 24);
    expect(result.filter(p => p.time === 2)).toHaveLength(1);
    expect(result.find(p => p.time === 1)?.command).toBe('M');
    expect(result.find(p => p.time === 3.05)?.command).toBe('M');
    expect(result.find(p => p.time === 4)?.y).toBe((72 - 70 + 0.5) * 24);
  });
});
