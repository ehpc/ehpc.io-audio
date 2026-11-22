import { describe, expect, it } from "vitest";
import type { JobDTO } from "~/api";
import { karaokeLines, karaokeWordState, type KaraokeLine, type KaraokeWord } from "./karaoke";

type Presentation = NonNullable<JobDTO["transcript"]>["presentation_lines"][number];
type Word = NonNullable<NonNullable<JobDTO["transcript"]>["words"]>[number];

function line(text: string, onset_s: number | null, end_s: number | null, words: Presentation["words"] = [], source_kind: Presentation["source_kind"] = "canonical"): Presentation {
  return { text, onset_s, end_s, words, source_kind, source_index: 0,
    canonical_line_index: source_kind === "canonical" ? 0 : null, onset_source: onset_s === null ? "unknown" : "provider-synced" };
}
function word(text: string, start_s: number, end_s: number): Word {
  return { text, start_s, end_s, probability: null, origin: "reference-aligned" };
}
function source(lines: Presentation[], words: Word[], tempo = 125): Pick<JobDTO, "transcript" | "pitch" | "options" | "lyric_pitch_lines"> {
  return {
    transcript: { presentation_lines: lines, words } as NonNullable<JobDTO["transcript"]>,
    pitch: { tempo_percent: tempo, duration_s: 12 } as NonNullable<JobDTO["pitch"]>,
    options: { tempo_percent: tempo } as JobDTO["options"], lyric_pitch_lines: null,
  };
}
function words(line: KaraokeLine): KaraokeWord[] {
  return line.parts.filter((part): part is KaraokeWord => typeof part !== "string");
}

describe("karaoke highlight projection", () => {
  it("starts the first estimated word at the line cue and weights a gap before a measured third word", () => {
    const job = source([
      line("I larger third tail", 1.25, null, [{ word_index: 0, token_index: 2 }]),
      line("Next", 10, null),
    ], [word("third", 5, 6.25)]);
    const original = structuredClone(job);
    const parts = words(karaokeLines(job)[0]);
    expect(karaokeWordState(parts[0].timing, 1).state).toBe("active");
    expect(parts[0].timing!.start_s).toBe(1);
    expect(parts[0].timing!.end_s).toBeCloseTo(1 + 3 / 7);
    expect(parts[1].timing!.start_s).toBe(parts[0].timing!.end_s);
    expect(parts[1].timing!.end_s).toBe(4);
    expect(parts[2].timing).toEqual({ start_s: 4, end_s: 5 });
    expect(parts[3].timing).toEqual({ start_s: 5, end_s: 8 });
    expect(karaokeWordState(parts[0].timing, parts[0].timing!.end_s).state).toBe("complete");
    expect(karaokeWordState(parts[1].timing, parts[0].timing!.end_s).state).toBe("active");
    expect(parts.map(part => part.timingOrigin)).toEqual(["estimated", "estimated", "measured", "estimated"]);
    expect(job).toEqual(original);
  });

  it.each([80, 125])("weights an entirely unanchored bounded Unicode/hyphen segment once at tempo %i", tempo => {
    const rate = tempo / 100;
    const job = source([line("山 abc-def", 2 * rate, 9 * rate, [], "segment")], [], tempo);
    const parts = words(karaokeLines(job)[0]);
    expect(parts.map(part => part.text)).toEqual(["山", "abc", "def"]);
    expect(parts.map(part => part.timing)).toEqual([
      { start_s: 2, end_s: 3 }, { start_s: 3, end_s: 6 }, { start_s: 6, end_s: 9 },
    ]);
    expect(parts.map(part => part.timingOrigin)).toEqual(["estimated", "estimated", "estimated"]);
  });

  it("does not bridge an untimed canonical line or invent an unbounded end", () => {
    const job = source([
      line("Before known after", 1.25, null, [{ word_index: 0, token_index: 1 }]),
      line("Unknown line", null, null),
      line("Later line", 10, null),
    ], [word("known", 5, 6.25)]);
    const result = karaokeLines(job);
    const first = words(result[0]);
    expect(first.map(part => part.timingOrigin)).toEqual(["estimated", "measured", undefined]);
    expect(first[0].timing).toEqual({ start_s: 1, end_s: 4 });
    expect(first[2].timing).toBeNull();
    expect(words(result[1]).every(part => part.timing === null && part.timingOrigin === undefined)).toBe(true);
  });

  it("retains conflicting or provider-overhanging measured words without manufacturing gaps", () => {
    const conflicting = source([
      line("one known late", 1.25, null, [{ word_index: 0, token_index: 1 }, { word_index: 1, token_index: 2 }]),
      line("Next", 10, null),
    ], [word("known", 5, 7.5), word("late", 6.25, 8.75)]);
    const parts = words(karaokeLines(conflicting)[0]);
    expect(parts[0].timing).toBeNull();
    expect(parts[1].timing).toEqual({ start_s: 4, end_s: 6 });
    expect(parts[2].timing).toEqual({ start_s: 5, end_s: 7 });
    expect(parts.slice(1).map(part => part.timingOrigin)).toEqual(["measured", "measured"]);

    const overhang = source([
      line("first last", 1.25, null, [{ word_index: 0, token_index: 1 }]),
      line("Next", 3.75, null),
    ], [word("last", 4, 5)]);
    const overhangingWords = words(karaokeLines(overhang)[0]);
    expect(overhangingWords[0].timing).toBeNull();
    expect(overhangingWords[1].timing).toEqual({ start_s: 3.2, end_s: 4 });
  });
});
