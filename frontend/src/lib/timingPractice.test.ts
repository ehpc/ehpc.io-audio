import { describe, expect, it } from "vitest";
import type { JobDTO } from "~/api";
import { timingSelection, timingPracticeLines, timingWindows, type TimingHintLevel } from "./timingPractice";

describe("timing practice windows", () => {
  it("covers four to zero partial seconds with stable nested disjoint cells", () => {
    const lines = [{ start_s: 2, end_s: 7 }];
    const sequence = [0.3, 0.8, 0.1, 0.6, 0.2];
    let index = 0;
    const selection = timingSelection(lines, () => sequence[index++ % sequence.length]);
    index = 0;
    expect(timingSelection(lines, () => sequence[index++ % sequence.length])).toEqual(selection);
    const cells = [...selection[0]].sort((a, b) => a.start_s - b.start_s);
    expect(cells).toHaveLength(5);
    for (let i = 0; i < cells.length; i++) {
      expect(cells[i].end_s - cells[i].start_s).toBe(1);
      expect(cells[i].start_s).toBeGreaterThanOrEqual(2);
      expect(cells[i].end_s).toBeLessThanOrEqual(7);
      if (i) expect(cells[i].start_s).toBeGreaterThanOrEqual(cells[i - 1].end_s);
    }
    const spans = [0, 1, 2, 3, 4].map(level => timingWindows(lines, selection, level as TimingHintLevel));
    expect(timingWindows(lines, selection, 5)).toEqual([]); // Full stream bypasses the gate.
    expect(spans.slice().reverse().map(windows => windows.reduce((sum, w) => sum + w.end_s - w.start_s, 0))).toEqual([4, 3, 2, 1, 0]);
    for (let level = 1; level < 4; level++) {
      for (const span of spans[level]) expect(spans[level + 1].some(other => other.start_s <= span.start_s && other.end_s >= span.end_s)).toBe(true);
      expect(timingWindows(lines, selection, level as TimingHintLevel)).toEqual(spans[level]);
    }
  });

  it("rounds fractional targets and clips subsecond lines without extending bounds", () => {
    const lines = [{ start_s: 2, end_s: 5.6 }, { start_s: 8, end_s: 8.3 }];
    const selection = timingSelection(lines, () => 0.5);
    expect(selection[0]).toHaveLength(3);
    expect(selection[1]).toEqual([{ start_s: 8, end_s: 8.3 }]);
    for (const [level, count] of [[1, 1], [2, 1], [3, 2], [4, 3]] as const) {
      const windows = timingWindows(lines, selection, level);
      const first = windows.filter(w => w.start_s < 8);
      expect(first.reduce((sum, w) => sum + w.end_s - w.start_s, 0)).toBeCloseTo(count);
      expect(first.every(w => w.start_s >= 2 && w.end_s <= 5.6)).toBe(true);
      expect(windows.at(-1)).toEqual({ start_s: 8, end_s: 8.3 });
    }
  });

  it("keeps independent line selections unchanged after merged gates and hint changes", () => {
    const lines = [{ start_s: 1, end_s: 6 }, { start_s: 10, end_s: 13 }];
    const selection = timingSelection(lines, () => 0);
    const original = structuredClone(selection);
    const wide = timingWindows(lines, selection, 4);
    const sparse = timingWindows(lines, selection, 1);
    expect(timingWindows(lines, selection, 4)).toEqual(wide);
    expect(selection).toEqual(original);
    for (const span of sparse) expect(wide.some(w => w.start_s <= span.start_s && w.end_s >= span.end_s)).toBe(true);
    for (const [line, coverage] of [[lines[0], 4], [lines[1], 2]] as const) {
      const within = wide.filter(w => w.start_s >= line.start_s && w.end_s <= line.end_s);
      expect(within.reduce((sum, w) => sum + w.end_s - w.start_s, 0)).toBe(coverage);
    }
    expect(wide.every(w => lines.some(line => w.start_s >= line.start_s && w.end_s <= line.end_s))).toBe(true);
  });

  it("uses supported output-clock line bounds without crossing an unknown cue", () => {
    const job = {
      options: { tempo_percent: 125 },
      pitch: { tempo_percent: 125, duration_s: 20 },
      lyric_pitch_lines: null,
      transcript: { words: [], presentation_lines: [
        { text: "first", source_kind: "canonical", source_index: 0, canonical_line_index: 0, onset_s: 2.5, end_s: null, onset_source: "provider-synced", words: [] },
        { text: "unknown", source_kind: "canonical", source_index: 1, canonical_line_index: 1, onset_s: null, end_s: null, onset_source: "unknown", words: [] },
        { text: "second", source_kind: "segment", source_index: 2, canonical_line_index: null, onset_s: 10, end_s: 15, onset_source: "acoustic", words: [] },
      ] },
    } as unknown as JobDTO;
    expect(timingPracticeLines(job)).toEqual([{ start_s: 8, end_s: 12 }]);
  });
});
