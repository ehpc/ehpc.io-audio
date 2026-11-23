import { describe, expect, it } from "vitest";
import type { JobDTO } from "~/api";
import { timingCenters, timingPracticeLines, timingWindows } from "./timingPractice";

describe("timing practice windows", () => {
  it("keeps randomized windows stable, nested, bounded and merged", () => {
    const lines = [{ start_s: 2, end_s: 7 }, { start_s: 10, end_s: 10.3 }];
    const values = [0, 0.5, 1, 1, 0.5, 0];
    let index = 0;
    const centers = timingCenters(lines, () => values[index++]);
    const sparse = timingWindows(lines, centers, 1);
    const medium = timingWindows(lines, centers, 2);
    const wide = timingWindows(lines, centers, 3);
    expect(timingWindows(lines, centers, 0)).toEqual([]);
    expect(timingWindows(lines, centers, 4)).toEqual([]);
    expect(sparse).toEqual(timingWindows(lines, centers, 1));
    for (const [smaller, bigger] of [[sparse, medium], [medium, wide]] as const) {
      for (const span of smaller) expect(bigger.some(other => other.start_s <= span.start_s && other.end_s >= span.end_s)).toBe(true);
    }
    for (const span of wide) expect(lines.some(line => span.start_s >= line.start_s && span.end_s <= line.end_s)).toBe(true);
    expect(wide.filter(span => span.start_s >= 10)).toEqual([{ start_s: 10, end_s: 10.3 }]);
    expect(sparse[0].end_s - sparse[0].start_s).toBeCloseTo(0.5);
  });

  it("keeps requested duration at both edges unless the entire line is shorter", () => {
    const lines = [{ start_s: 1, end_s: 5 }, { start_s: 7, end_s: 7.2 }];
    const centers = [[1.01, 4.99], [7.1]];
    const sparse = timingWindows(lines, centers, 1);
    const medium = timingWindows(lines, centers, 2);
    expect(sparse).toEqual([
      { start_s: 1, end_s: 1.5 }, { start_s: 4.5, end_s: 5 }, { start_s: 7, end_s: 7.2 },
    ]);
    expect(medium).toEqual([
      { start_s: 1, end_s: 2 }, { start_s: 4, end_s: 5 }, { start_s: 7, end_s: 7.2 },
    ]);
    for (const span of sparse) expect(medium.some(other => other.start_s <= span.start_s && other.end_s >= span.end_s)).toBe(true);
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
