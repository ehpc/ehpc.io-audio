import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import type { AlignedWordDTO, JobDTO, ReferenceLineDTO, TranscriptDTO } from "~/api";
import { currentKaraokeLine, karaokeLines, karaokeWordState, type KaraokeLine, type KaraokeWord } from "~/lib/karaoke";
import TimelineKaraoke from "./TimelineKaraoke";

function word(text: string, start_s: number, end_s: number): AlignedWordDTO {
  return { text, start_s, end_s, probability: null, origin: "reference-aligned" };
}

function referenceLine(text: string, start_s: number | null, end_s: number | null): ReferenceLineDTO {
  return { text, start_s, end_s, status: start_s === null ? "unconfirmed" : "aligned", support: 0.7,
    reason: "fixture", unconfirmed_words: [], recognized_variant: null };
}

function job(): JobDTO {
  const transcript: TranscriptDTO = {
    status: "recognized", language: "en", timestamp_reference: "original", sections: [],
    structure_model: null, segments: [], timestamped_text: "",
    words: [word("go", 5, 6.25), word("don't", 7.5, 8.75), word("Go", 10, 11.25), word("don't", 12.5, 13.75)],
    canonical_word_positions: [
      { word_index: 0, reference_line_index: 0, reference_token_index: 1 },
      { word_index: 1, reference_line_index: 0, reference_token_index: 2 },
      { word_index: 2, reference_line_index: 1, reference_token_index: 0 },
      { word_index: 3, reference_line_index: 1, reference_token_index: 2 },
    ],
    presentation_lines: [
      { text: "Go, go—don't stop!", source_kind: "canonical", source_index: 0, canonical_line_index: 0, onset_s: 5, end_s: null, onset_source: "acoustic",
        words: [{ word_index: 0, token_index: 1 }, { word_index: 1, token_index: 2 }] },
      { text: "Go, go—don't stop!", source_kind: "canonical", source_index: 1, canonical_line_index: 1, onset_s: 10, end_s: null, onset_source: "acoustic",
        words: [{ word_index: 2, token_index: 0 }, { word_index: 3, token_index: 2 }] },
      { text: "Unknown refrain", source_kind: "canonical", source_index: 2, canonical_line_index: 2, onset_s: null, end_s: null, onset_source: "unknown", words: [] },
    ],
    reference: {
      status: "partial", reason: "fixture", provider: "fixture", source_url: null, record_id: null,
      artist: null, title: null, album: null, duration_s: null, agreement: null,
      corrections: [], original_segments: [], original_words: [],
      lines: [referenceLine("Go, go—don't stop!", 5, 8.75), referenceLine("Go, go—don't stop!", 10, 13.75),
        { ...referenceLine("Unknown refrain", null, null), provider_start_s: 20, provider_end_s: 22 }],
    },
  };
  return {
    id: 37, song_id: null, status: "done", position: null, source_type: "upload", source_value: "fixture.wav", title: null,
    progress: { steps: ["source", "analysis", "separation", "lyrics", "pitch", "export"], current: null },
    original_key: null, output_key: null, result_revision: null, error_message: null, created_at: 1, has_original: true,
    lyric_pitch_lines: null,
    has_pitch_vocals: true, manifest: null, transcript,
    options: { detect_pitch: true, extract_lyrics: true, extract_vocals: true, extract_instruments: false,
      extract_pitched_lyrics: false, mixes: [], decrowd: false, decrowd_vocals: false, dereverb: false,
      genders: false, lead_backing: false, drums: false, pitch_semitones: 0, tempo_percent: 125 },
    pitch: { version: 1, model: "fixture", source_duration_s: 30, duration_s: 24,
      pitch_shift_semitones: 0, tempo_percent: 125, timestamp_reference: "output", pitch_reference: "output",
      word_alignment: "fixture", tracks: [], words: [word("unrelated filtered pitch word", 18, 19)] },
  };
}

function lexicalWords(line: KaraokeLine): KaraokeWord[] {
  return line.parts.filter((part): part is KaraokeWord => typeof part !== "string");
}

it("masks both fullscreen lines and punctuation without leaking lyrics or pitch labels", () => {
  const source = job();
  const [hint, setHint] = createSignal<"full" | "partial" | "first" | "hidden">("full");
  const [position, setPosition] = createSignal(4.5);
  render(() => <TimelineKaraoke job={source} position={position()} fit showPitches learningHint={hint()} />);
  const current = screen.getByRole("group", { name: "Current lyrics" });
  const next = screen.getByRole("group", { name: "Next lyrics" });
  expect(current).toHaveTextContent("Go, go—don't stop!");
  expect(screen.queryByRole("button", { name: "Pitches" })).not.toBeInTheDocument();
  setHint("partial");
  expect(current).not.toHaveTextContent("don't");
  setHint("hidden");
  for (const line of [current, next]) {
    expect(line.textContent).toMatch(/^[•\s]+$/u);
    expect(line.querySelector("[title*=\"don't\"], [aria-label*=\"don't\"]")).toBeNull();
    for (const estimated of line.querySelectorAll('[data-timing="estimated"]')) expect(estimated).toHaveAttribute("title", "Estimated word timing");
  }
  expect(current.querySelector('[aria-current="true"]')).toBeInTheDocument();
  setPosition(7.5);
  expect(current.querySelector('[aria-current="true"]')).toHaveAttribute("data-timing", "estimated");
  expect(current.querySelector('[aria-current="true"]')).toHaveTextContent("••••");
  setPosition(8.5);
  expect(screen.getByRole("group", { name: "Current lyrics" }).textContent).toMatch(/^[•\s]+$/u);
});

it("shows partial-word estimates and line-only pitches on the selected projected track", () => {
  const source = job();
  const line = source.transcript!.presentation_lines[0];
  source.lyric_pitch_lines = [{
    source_kind: line.source_kind, source_index: line.source_index, canonical_line_index: line.canonical_line_index,
    start_s: 4, end_s: 8, bounds_source: "acoustic",
    words: [
      { token_index: 1, start_s: 4, end_s: 5, origin: "measured", tracks: [{ track_index: 0, note_indices: [0] }] },
      { token_index: 3, start_s: 7, end_s: 8, origin: "interpolated", tracks: [{ track_index: 0, note_indices: [1] }] },
    ],
    tracks: [{ track_index: 0, note_indices: [2] }, { track_index: 1, note_indices: [0] }],
  }];
  const note = (name: string) => ({ start_s: 4, end_s: 5, midi: 60, frequency_hz: 261.6,
    confidence: 0.9, note: name, cents: 0, word_indices: [] });
  const [notes, setNotes] = createSignal([note("C4"), note("D4"), note("E4")]);
  const [trackIndex, setTrackIndex] = createSignal(0);
  render(() => <TimelineKaraoke job={source} position={4.5} notes={notes()} trackIndex={trackIndex()} />);
  const current = screen.getByRole("group", { name: "Current lyrics" });
  expect(within(current).queryByRole("group", { name: /pitches/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
  expect(within(current).getByRole("group", { name: "Pitches for go: C4" })).toBeVisible();
  expect(within(current).getByRole("group", { name: "Estimated pitches for stop: D4" })).toHaveTextContent("~D4");
  expect(within(current).getByRole("group", { name: "Estimated pitches for this line: E4" })).toBeVisible();
  expect(within(current).getByText("stop")).toHaveAttribute("data-timing", "estimated");
  setNotes([note("G4")]);
  setTrackIndex(1);
  expect(within(current).getByRole("group", { name: "Estimated pitches for this line: G4" })).toBeVisible();
  expect(within(current).queryByRole("group", { name: /pitches for stop/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
  expect(within(current).queryByRole("group", { name: /pitches/i })).toBeNull();
});

it("keeps line-only pitch associations on their own repeated occurrence", () => {
  const source = job();
  const lines = source.transcript!.presentation_lines;
  source.lyric_pitch_lines = lines.slice(0, 2).map((line, index) => ({
    source_kind: line.source_kind, source_index: line.source_index, canonical_line_index: line.canonical_line_index,
    start_s: 4 + 4 * index, end_s: 8 + 4 * index, bounds_source: "provider-synced" as const,
    words: [], tracks: [{ track_index: 0, note_indices: [index] }],
  }));
  const note = (name: string) => ({ start_s: 4, end_s: 5, midi: 60, frequency_hz: 261.6,
    confidence: 0.9, note: name, cents: 0, word_indices: [] });
  const [position, setPosition] = createSignal(4.5);
  render(() => <TimelineKaraoke job={source} position={position()} notes={[note("C4"), note("G4")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
  expect(within(screen.getByRole("group", { name: "Current lyrics" })).getByRole("group", { name: "Estimated pitches for this line: C4" })).toBeVisible();
  setPosition(8.5);
  expect(within(screen.getByRole("group", { name: "Current lyrics" })).getByRole("group", { name: "Estimated pitches for this line: G4" })).toBeVisible();
});

it("does not attach pitches to a transcript line when derived associations are unavailable", () => {
  const source = job();
  source.pitch!.words = [word("go", 4, 5)];
  const note = { start_s: 4, end_s: 5, midi: 60, frequency_hz: 261.6,
    confidence: 0.9, note: "C4", cents: 0, word_indices: [0] };
  render(() => <TimelineKaraoke job={source} position={4.5} notes={[note]} />);
  fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
  expect(within(screen.getByRole("group", { name: "Current lyrics" })).queryByRole("group", { name: /pitches/i })).toBeNull();
});

it("compresses only consecutive displayed pitch labels within each word or line", () => {
  const source = job();
  const line = source.transcript!.presentation_lines[0];
  source.lyric_pitch_lines = [{
    source_kind: line.source_kind, source_index: line.source_index, canonical_line_index: line.canonical_line_index,
    start_s: 4, end_s: 8, bounds_source: "acoustic",
    words: [
      { token_index: 1, start_s: 4, end_s: 5, origin: "measured", tracks: [{ track_index: 0, note_indices: [0, 1, 2, 3, 4] }] },
      { token_index: 2, start_s: 6, end_s: 7, origin: "measured", tracks: [{ track_index: 0, note_indices: [4, 5] }] },
    ],
    tracks: [{ track_index: 0, note_indices: [0, 1, 2, 3, 4] }],
  }];
  const note = (name: string) => ({ start_s: 4, end_s: 5, midi: 60, frequency_hz: 261.6, confidence: 0.9, note: name, cents: 0, word_indices: [] });
  const raw = ["C4", "C4", "C5", "C4", "D4", "D4"].map(note);
  const [notes, setNotes] = createSignal(raw);
  render(() => <TimelineKaraoke job={source} position={4.5} notes={notes()} />);
  fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
  expect(screen.getByRole("group", { name: "Pitches for go: C4 C5 C4 D4" })).toBeVisible();
  expect(screen.getByRole("group", { name: "Pitches for don't: D4" })).toBeVisible();
  expect(screen.getByRole("group", { name: "Estimated pitches for this line: C4 C5 C4 D4" })).toBeVisible();
  setNotes(["D4", "D4", "D5", "D4", "E4", "E4"].map(note));
  expect(screen.getByRole("group", { name: "Pitches for go: D4 D5 D4 E4" })).toBeVisible();
  expect(raw.map(item => item.note)).toEqual(["C4", "C4", "C5", "C4", "D4", "D4"]);
});

it("compresses consecutive labels in the pitch-only fallback without merging words", () => {
  const source = job();
  source.transcript = null;
  source.pitch!.words = [word("first", 4, 5), word("second", 6, 7)];
  const note = (name: string, index: number) => ({ start_s: 4, end_s: 5, midi: 60, frequency_hz: 261.6, confidence: 0.9, note: name, cents: 0, word_indices: [index] });
  const notes = [note("C4", 0), note("C4", 0), note("C5", 0), note("C4", 0), note("C4", 1)];
  const [position, setPosition] = createSignal(4.5);
  render(() => <TimelineKaraoke job={source} position={position()} notes={notes} />);
  fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
  expect(screen.getByRole("group", { name: "Pitches for first: C4 C5 C4" })).toBeVisible();
  setPosition(6.5);
  expect(screen.getByRole("group", { name: "Pitches for second: C4" })).toBeVisible();
});

describe("karaoke provenance and output clock", () => {
  it("maps original words once at 125%, retaining partial and repeated canonical positions", () => {
    const lines = karaokeLines(job());
    expect(lexicalWords(lines[0]).map(part => [part.text, part.timing, part.timingOrigin])).toEqual([
      ["Go", null, undefined], ["go", { start_s: 4, end_s: 5 }, "measured"], ["don't", { start_s: 6, end_s: 7 }, "measured"], ["stop", { start_s: 7, end_s: 8 }, "estimated"],
    ]);
    expect(lexicalWords(lines[1]).map(part => [part.timing, part.timingOrigin])).toEqual([
      [{ start_s: 8, end_s: 9 }, "measured"], [{ start_s: 9, end_s: 10 }, "estimated"], [{ start_s: 10, end_s: 11 }, "measured"], [null, undefined],
    ]);
    expect(lines[2].timing).toBeNull();
    expect(lines[0].parts.map(part => typeof part === "string" ? part : part.text).join("")).toBe("Go, go—don't stop!");
  });

  it("indexes apostrophes, hyphens, underscores, CJK and Unicode numbers like backend canonical tokens", () => {
    const source = job();
    const text = "L’amour—can't_e\u0301lan 再见 １２³! Go, go.";
    source.transcript!.reference!.lines = [referenceLine(text, 5, 13)];
    source.transcript!.words = [word("l'amour", 5, 6), word("can't", 6, 7), word("e", 7, 8),
      word("lan", 8, 9), word("再见", 9, 10), word("123", 10, 11), word("go", 12, 13)];
    source.transcript!.presentation_lines = [{
      text, source_kind: "canonical", source_index: 0, canonical_line_index: 0, onset_s: 5, end_s: null, onset_source: "acoustic",
      words: [0, 1, 2, 3, 4, 5, 7].map((token, index) => ({ word_index: index, token_index: token })),
    }];
    const line = karaokeLines(source)[0];
    expect(lexicalWords(line).map(part => [part.text, part.timingOrigin])).toEqual([
      ["L’amour", "measured"], ["can't", "measured"], ["e", "measured"], ["lan", "measured"],
      ["再见", "measured"], ["１２³", "measured"], ["Go", "estimated"], ["go", "measured"],
    ]);
    expect(line.parts.map(part => typeof part === "string" ? part : part.text).join("")).toBe(text);
  });

  it("uses provider onset as an explicitly estimated leading word", () => {
    const source = job();
    source.transcript!.presentation_lines[0].onset_s = 1.25;
    source.transcript!.presentation_lines[0].onset_source = "provider-synced";
    const lines = karaokeLines(source);
    expect(lines[0].timing).toEqual({ start_s: 1, end_s: 8 });
    expect(lexicalWords(lines[0]).map(part => [part.timing, part.timingOrigin])).toEqual([
      [{ start_s: 1, end_s: 4 }, "estimated"], [{ start_s: 4, end_s: 5 }, "measured"],
      [{ start_s: 6, end_s: 7 }, "measured"], [{ start_s: 7, end_s: 8 }, "estimated"],
    ]);
    const [position, setPosition] = createSignal(1);
    render(() => <TimelineKaraoke job={source} position={position()} />);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent("Go, go—don't stop!");
    expect(screen.getByRole("region", { name: "Current karaoke line" }).querySelector("[aria-current]")).toHaveAttribute("title", "Estimated word timing");
    fireEvent.click(screen.getByText("Unscheduled lyrics (1)"));
    expect(screen.getByText("Unknown refrain")).toBeVisible();
    setPosition(4.5);
    expect(screen.getByRole("region", { name: "Current karaoke line" }).querySelector("[aria-current]")).toHaveTextContent("go");
  });

  it("preserves accepted extra words between repeated lines and seeks by output time", () => {
    const source = job();
    source.transcript!.presentation_lines[1].onset_s = 20;
    source.transcript!.words![2] = word("Go", 20, 21.25);
    source.transcript!.words![3] = word("don't", 22.5, 23.75);
    source.transcript!.words!.push(
      { ...word("actual", 12.5, 13.75), origin: "asr-extra" },
      { ...word("adlib", 15, 16.25), origin: "asr-extra" },
    );
    source.transcript!.presentation_lines.splice(1, 0,
      { text: "actual", source_kind: "asr-word", source_index: 4, canonical_line_index: null, onset_s: 12.5, end_s: 13.75, onset_source: "acoustic", words: [{ word_index: 4, token_index: 0 }] },
      { text: "adlib", source_kind: "asr-extra", source_index: 0, canonical_line_index: null, onset_s: 15, end_s: 16.25, onset_source: "acoustic", words: [{ word_index: 5, token_index: 0 }] },
    );
    source.pitch!.words = [{ ...word("actual", 10, 11), origin: "asr-extra" }];
    const lines = karaokeLines(source);
    expect(lines.map(line => [line.text, line.timing])).toEqual([
      ["Go, go—don't stop!", { start_s: 4, end_s: 16 }],
      ["actual", { start_s: 10, end_s: 11 }],
      ["adlib", { start_s: 12, end_s: 13 }],
      ["Go, go—don't stop!", { start_s: 16, end_s: 24 }],
      ["Unknown refrain", null],
    ]);
    expect(lexicalWords(lines[1])[0]).toMatchObject({ timing: { start_s: 10, end_s: 11 } });
    expect(currentKaraokeLine(lines, 10.5)?.text).toBe("actual");
    expect(currentKaraokeLine(lines, 16.5)?.text).toBe("Go, go—don't stop!");
    expect(currentKaraokeLine(lines, 12.5)?.text).toBe("adlib");
    expect(currentKaraokeLine(lines, 11.5)?.text).toBe("Go, go—don't stop!");
    expect(currentKaraokeLine(lines, 4.5)?.text).toBe("Go, go—don't stop!");
    const [position, setPosition] = createSignal(10.5);
    render(() => <TimelineKaraoke job={source} position={position()} />);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent("actual");
    setPosition(11.5);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent("Go, go—don't stop!");
    setPosition(12.5);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent("adlib");
    setPosition(4.5);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent("Go, go—don't stop!");
    expect(screen.queryByText("actual", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("adlib", { exact: true })).not.toBeInTheDocument();
  });

  it("uses projected onsets rather than reference bounds and keeps unknown onsets unscheduled", () => {
    const source = job();
    source.transcript!.reference!.lines![0] = referenceLine("Go, go—don't stop!", 6.25, 7.5);
    const lines = karaokeLines(source);
    expect(lines[0].timing).toEqual({ start_s: 4, end_s: 8 });
    expect(lines[2].timing).toBeNull();
    expect(currentKaraokeLine(lines, 7.99)).toBe(lines[0]);
    expect(currentKaraokeLine(lines, 8)).toBe(lines[1]);
    expect(currentKaraokeLine(lines, 0)).toBeNull();
  });

  it("converts provider onset and actual word bounds once at slower tempo", () => {
    const source = job();
    source.pitch!.tempo_percent = 50;
    source.pitch!.duration_s = 60;
    source.transcript!.presentation_lines[0].onset_s = 2;
    source.transcript!.presentation_lines[0].onset_source = "provider-synced";
    const lines = karaokeLines(source);
    expect(lines[0].timing).toEqual({ start_s: 4, end_s: 20 });
    expect(lexicalWords(lines[0])[1].timing).toEqual({ start_s: 10, end_s: 12.5 });
    expect(lines[1].timing).toEqual({ start_s: 20, end_s: 60 });
  });

  it("uses actual continuous word duration, not syllables or a timer state machine", () => {
    const timing = { start_s: 4, end_s: 6 };
    expect(karaokeWordState(timing, 3)).toEqual({ state: "pending", progress: 0 });
    expect(karaokeWordState(timing, 4.25)).toEqual({ state: "active", progress: 0.125 });
    expect(karaokeWordState(timing, 5.5)).toEqual({ state: "active", progress: 0.75 });
    expect(karaokeWordState(timing, 6)).toEqual({ state: "complete", progress: 1 });
    expect(karaokeWordState(timing, 4)).toEqual({ state: "active", progress: 0 });
    expect(karaokeWordState(null, 99)).toEqual({ state: "untimed", progress: 0 });
  });

  it("keeps repeated segments separate while estimating ambiguous missing words", () => {
    const source = job();
    source.transcript!.reference = null;
    source.transcript!.presentation_lines = [
      { text: "Go go home!", source_kind: "segment", source_index: 0, canonical_line_index: null, onset_s: 5, end_s: 8.75, onset_source: "acoustic", words: [{ word_index: 1, token_index: 2 }] },
      { text: "Go go home!", source_kind: "segment", source_index: 1, canonical_line_index: null, onset_s: 10, end_s: 13.75, onset_source: "acoustic", words: [{ word_index: 2, token_index: 0 }, { word_index: 3, token_index: 1 }, { word_index: 4, token_index: 2 }] },
    ];
    source.transcript!.segments = [
      { text: "Go go home!", start_s: 5, end_s: 8.75 },
      { text: "Go go home!", start_s: 10, end_s: 13.75 },
    ];
    source.transcript!.words = [word("go", 5, 6.25), word("home", 7.5, 8.75),
      word("Go", 10, 11.25), word("go", 11.25, 12.5), word("home", 12.5, 13.75)];
    const lines = karaokeLines(source);
    expect(lexicalWords(lines[0]).map(part => [part.timing, part.timingOrigin])).toEqual([
      [{ start_s: 4, end_s: 5 }, "estimated"], [{ start_s: 5, end_s: 6 }, "estimated"], [{ start_s: 6, end_s: 7 }, "measured"],
    ]);
    expect(lexicalWords(lines[1]).map(part => part.timing)).toEqual([
      { start_s: 8, end_s: 9 }, { start_s: 9, end_s: 10 }, { start_s: 10, end_s: 11 },
    ]);
  });

  it("keeps pitch-only timings in output seconds and never invents phrases or timing for invalid words", () => {
    const source = job();
    source.transcript = null;
    source.pitch!.words = [word("First", 4, 5), word("Second", 6, 7), word("Unknown", 8, 8)];
    const lines = karaokeLines(source);
    expect(lines.map(line => [line.text, line.timing])).toEqual([
      ["First", { start_s: 4, end_s: 5 }], ["Second", { start_s: 6, end_s: 7 }],
    ]);
    expect(currentKaraokeLine(lines, 3)?.text).toBe("First");
    source.pitch!.words = [];
    expect(karaokeLines(source)).toEqual([]);
  });


  it("retains direct pitch indices for historical pitch-only words", () => {
    const source = job();
    source.transcript = null;
    source.pitch!.words = [word("same", 4, 5), word("same", 6, 7)];
    expect(karaokeLines(source).map(line => lexicalWords(line)[0].pitchIndex)).toEqual([0, 1]);
  });
});

describe("TimelineKaraoke reactive reader", () => {
  it("shows measured and estimated words without filling unsupported gaps", () => {
    const [position, setPosition] = createSignal(3);
    render(() => <TimelineKaraoke job={job()} position={position()} />);
    const region = screen.getByRole("region", { name: "Current karaoke line" });
    expect(region).toHaveAttribute("aria-live", "off");
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent(/^Go, go—don't stop!$/);
    expect(screen.getByRole("group", { name: "Next lyrics" })).toHaveTextContent(/^Go, go—don't stop!$/);
    expect(region.querySelector("[aria-current]")).toBeNull();
    setPosition(4.5);
    expect(region.querySelector("[aria-current]")).toHaveTextContent(/^go$/);
    expect([...screen.getByRole("group", { name: "Current lyrics" }).querySelectorAll('[data-state="untimed"]')].map(word => word.textContent)).toEqual(["Go"]);
    expect(within(screen.getByRole("group", { name: "Current lyrics" })).getByText("stop")).toHaveAttribute("title", "Estimated word timing");
    setPosition(5.5);
    expect(region.querySelector("[aria-current]")).toBeNull();
    expect(screen.getByRole("group", { name: "Current lyrics" }).querySelector('[data-state="complete"]')).toHaveTextContent(/^go$/);
    expect(screen.getByRole("group", { name: "Current lyrics" }).querySelector('[data-state="pending"]')).toHaveTextContent("don't");
    setPosition(4.25);
    expect(region.querySelector("[aria-current]")).toHaveTextContent(/^go$/);
  });

  it("selects the correct repeated occurrence at lead-in, end and backward seek, then discards old-job lyrics", () => {
    const [source, setSource] = createSignal(job());
    const [position, setPosition] = createSignal(6.9);
    render(() => <TimelineKaraoke job={source()} position={position()} />);
    const region = screen.getByRole("region", { name: "Current karaoke line" });
    expect(region.querySelector("[aria-current]")).toHaveTextContent("don't");
    setPosition(7);
    expect(region.querySelector("[aria-current]")).toHaveTextContent("stop");
    expect(region.querySelector("[aria-current]")).toHaveAttribute("data-timing", "estimated");
    expect(region.querySelector('[data-state="pending"]')).toHaveTextContent(/^Go$/);
    setPosition(8.5);
    expect(region.querySelector("[aria-current]")).toHaveTextContent(/^Go$/);
    setPosition(24);
    expect(region.querySelectorAll('[data-state="complete"]')).toHaveLength(3);
    expect(region.querySelector("[aria-current]")).toBeNull();
    setPosition(4.5);
    expect(region.querySelector("[aria-current]")).toHaveTextContent(/^go$/);
    const empty = job();
    empty.transcript = null;
    empty.pitch!.words = [];
    setSource(empty);
    expect(region).not.toHaveTextContent("Go, go—don't stop!");
    expect(region.querySelector("[aria-current]")).toBeNull();
  });

  it.each(["canonical", "segment"] as const)("keeps a partial %s phrase visible through its estimated tail", kind => {
    const source = job();
    const text = "Before known after";
    source.transcript!.words = [word("known", 6.25, 7.5), word("Next", 11.875, 13.125)];
    source.transcript!.canonical_word_positions = [
      { word_index: 0, reference_line_index: 0, reference_token_index: 1 },
      { word_index: 1, reference_line_index: 1, reference_token_index: 0 },
    ];
    source.transcript!.reference!.lines = [referenceLine(text, 5, 11.25), referenceLine("Next", 11.875, 13.125)];
    source.transcript!.presentation_lines = [
      { text, source_kind: "canonical", source_index: 0, canonical_line_index: 0, onset_s: 5, end_s: null, onset_source: "acoustic", words: [{ word_index: 0, token_index: 1 }] },
      { text: "Next", source_kind: "canonical", source_index: 1, canonical_line_index: 1, onset_s: 11.875, end_s: null, onset_source: "acoustic", words: [{ word_index: 1, token_index: 0 }] },
    ];
    if (kind === "segment") {
      source.transcript!.reference = null;
      source.transcript!.presentation_lines = [
        { text, source_kind: "segment", source_index: 0, canonical_line_index: null, onset_s: 5, end_s: 11.25, onset_source: "acoustic", words: [{ word_index: 0, token_index: 1 }] },
        { text: "Next", source_kind: "segment", source_index: 1, canonical_line_index: null, onset_s: 11.875, end_s: 13.125, onset_source: "acoustic", words: [{ word_index: 1, token_index: 0 }] },
      ];
      source.transcript!.segments = [
        { text, start_s: 5, end_s: 11.25 }, { text: "Next", start_s: 11.875, end_s: 13.125 },
      ];
    }
    const lines = karaokeLines(source);
    expect(lines[0].timing).toEqual({ start_s: 4, end_s: kind === "canonical" ? 9.5 : 9 });
    const [position, setPosition] = createSignal(3);
    render(() => <TimelineKaraoke job={source} position={position()} />);
    const region = screen.getByRole("region", { name: "Current karaoke line" });
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent(text);
    expect(screen.getByRole("group", { name: "Next lyrics" })).toHaveTextContent("Next");
    expect(region.querySelector("[aria-current]")).toBeNull();
    setPosition(5.5);
    expect(region.querySelector("[aria-current]")).toHaveTextContent("known");
    setPosition(8.75);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent(text);
    expect(region.querySelector("[aria-current]")).toHaveTextContent("after");
    expect(region.querySelector("[aria-current]")).toHaveAttribute("title", "Estimated word timing");
    expect(within(screen.getByRole("group", { name: "Current lyrics" })).getByText("Before")).toHaveAttribute("data-timing", "estimated");
    setPosition(kind === "canonical" ? 9.5 : 9);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent("Next");
    if (kind === "segment") expect(region.querySelector("[aria-current]")).toBeNull();
    setPosition(9.75);
    expect(region.querySelector("[aria-current]")).toHaveTextContent("Next");
  });

  it("renders only the selected stem's linked pitches above their words and toggles them", () => {
    const source = job();
    source.pitch!.words = [word("go", 4, 5), word("Go", 8, 9)];
    const line = source.transcript!.presentation_lines[0];
    source.lyric_pitch_lines = [{ source_kind: line.source_kind, source_index: line.source_index, canonical_line_index: line.canonical_line_index,
      start_s: 4, end_s: 8, bounds_source: "acoustic", words: [{ token_index: 1, start_s: 4, end_s: 5, origin: "measured", tracks: [{ track_index: 0, note_indices: [0, 1] }] }], tracks: [] }];
    const note = { start_s: 4, end_s: 5, midi: 60, frequency_hz: 261.6, note: "C4", cents: 0, confidence: 0.9, word_indices: [0] };
    const [notes, setNotes] = createSignal([note, { ...note, note: "D4" }]);
    render(() => <TimelineKaraoke job={source} position={4.5} notes={notes()} />);
    const current = screen.getByRole("group", { name: "Current lyrics" });
    const toggle = screen.getByRole("button", { name: "Pitches" });
    expect(within(current).getByText("go", { exact: true })).toBeVisible();
    expect(within(current).queryByText("C4 D4")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(within(current).getByText("C4 D4")).toBeVisible();
    expect(within(current).getByText("go", { exact: true }).closest(".timeline-karaoke-cell")).toContainElement(within(current).getByText("C4 D4"));
    setNotes([{ ...note, note: "G4" }]);
    expect(within(current).getByText("G4")).toBeVisible();
    expect(within(current).queryByText("C4 D4")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(within(current).queryByText("G4")).not.toBeInTheDocument();
    expect(within(current).getByText("go", { exact: true })).toBeVisible();
  });

  it("keeps repeated-word pitch sequences with their own occurrence through promotion and toggling", () => {
    const source = job();
    source.pitch!.words = [word("go", 4, 5), word("Go", 8, 9)];
    source.lyric_pitch_lines = source.transcript!.presentation_lines.slice(0, 2).map((line, index) => ({
      source_kind: line.source_kind, source_index: line.source_index, canonical_line_index: line.canonical_line_index,
      start_s: 4 + index * 4, end_s: 8 + index * 4, bounds_source: "acoustic",
      words: [{ token_index: index === 0 ? 1 : 0, start_s: 4 + index * 4, end_s: 5 + index * 4, origin: "measured", tracks: [{ track_index: 0, note_indices: index === 0 ? [0, 1] : [2] }] }], tracks: [],
    }));
    const base = { start_s: 4, end_s: 5, midi: 61, frequency_hz: 277.2, cents: 0, confidence: 0.9 };
    const notes = [
      { ...base, note: "C#4", word_indices: [0] },
      { ...base, note: "D#4", word_indices: [0] },
      { ...base, note: "F#5", word_indices: [1] },
    ];
    const [position, setPosition] = createSignal(4.5);
    render(() => <TimelineKaraoke job={source} position={position()} notes={notes} playing />);
    const current = screen.getByRole("group", { name: "Current lyrics" });
    const next = screen.getByRole("group", { name: "Next lyrics" });
    fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
    expect(within(current).getByRole("group", { name: "Pitches for go: C#4 D#4" }).parentElement)
      .toContainElement(within(current).getByText("go", { exact: true }));
    expect(within(current).getByText("go", { exact: true }).parentElement).toHaveTextContent(/^go—$/);
    expect(within(next).getByRole("group", { name: "Pitches for Go: F#5" }).parentElement)
      .toContainElement(within(next).getByText("Go", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
    expect(within(current).queryByRole("group", { name: /Pitches for/ })).not.toBeInTheDocument();
    expect(within(next).queryByRole("group", { name: /Pitches for/ })).not.toBeInTheDocument();
    setPosition(8.5);
    const promoted = screen.getByRole("group", { name: "Current lyrics" });
    expect(within(promoted).getByText("Go", { exact: true })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
    expect(within(promoted).getByRole("group", { name: "Pitches for Go: F#5" })).toBeVisible();
    expect(within(promoted).queryByRole("group", { name: /C#4/ })).not.toBeInTheDocument();
  });
});
