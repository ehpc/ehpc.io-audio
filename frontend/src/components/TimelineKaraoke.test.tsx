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
    reference: {
      status: "partial", reason: "fixture", provider: "fixture", source_url: null, record_id: null,
      artist: null, title: null, album: null, duration_s: null, agreement: null,
      corrections: [], original_segments: [], original_words: [],
      lines: [referenceLine("Go, go—don't stop!", 5, 8.75), referenceLine("Go, go—don't stop!", 10, 13.75),
        { ...referenceLine("Unknown refrain", null, null), provider_start_s: 20, provider_end_s: 22 }],
    },
  };
  return {
    id: 37, status: "done", position: null, source_type: "upload", source_value: "fixture.wav", title: null,
    original_key: null, output_key: null, error_message: null, created_at: 1, has_original: true,
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

describe("karaoke provenance and output clock", () => {
  it("maps original words once at 125%, retaining partial and repeated canonical positions", () => {
    const lines = karaokeLines(job());
    expect(lexicalWords(lines[0]).map(part => [part.text, part.timing])).toEqual([
      ["Go", null], ["go", { start_s: 4, end_s: 5 }], ["don't", { start_s: 6, end_s: 7 }], ["stop", null],
    ]);
    expect(lexicalWords(lines[1]).map(part => part.timing)).toEqual([
      { start_s: 8, end_s: 9 }, null, { start_s: 10, end_s: 11 }, null,
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
    source.transcript!.canonical_word_positions = [0, 1, 2, 3, 4, 5, 7].map((token, index) => ({
      word_index: index, reference_line_index: 0, reference_token_index: token,
    }));
    const line = karaokeLines(source)[0];
    expect(lexicalWords(line).map(part => [part.text, part.timing !== null])).toEqual([
      ["L’amour", true], ["can't", true], ["e", true], ["lan", true],
      ["再见", true], ["１２³", true], ["Go", false], ["go", true],
    ]);
    expect(line.parts.map(part => typeof part === "string" ? part : part.text).join("")).toBe(text);
  });

  it("does not schedule provider-only lines or manufacture word timing for aligned phrase bounds", () => {
    const source = job();
    source.transcript!.canonical_word_positions = [];
    const lines = karaokeLines(source);
    expect(lines[0].timing).toEqual({ start_s: 4, end_s: 7 });
    expect(lexicalWords(lines[0]).every(part => part.timing === null)).toBe(true);
    expect(lines[2].timing).toBeNull();
    expect(currentKaraokeLine(lines, 20)?.timing).toEqual({ start_s: 8, end_s: 11 });
    source.transcript!.reference!.lines = [lines[2]].map(line => ({ ...referenceLine(line.text, null, null),
      provider_start_s: 1, provider_end_s: 2 }));
    expect(currentKaraokeLine(karaokeLines(source), 1.5)).toBeNull();
  });

  it("uses accepted ASR gap words between canonical repetitions without timing an unknown reference line", () => {
    const source = job();
    source.transcript!.words![2] = word("Go", 20, 21.25);
    source.transcript!.words![3] = word("don't", 22.5, 23.75);
    source.transcript!.reference!.lines![1] = referenceLine("Go, go—don't stop!", 20, 23.75);
    source.transcript!.words!.push(
      { ...word("actual", 12.5, 13.75), origin: "asr-extra" },
      { ...word("adlib", 15, 16.25), origin: "asr-extra" },
    );
    const lines = karaokeLines(source);
    expect(lines.map(line => line.timing)).toEqual([
      { start_s: 4, end_s: 7 }, { start_s: 10, end_s: 11 }, { start_s: 12, end_s: 13 },
      { start_s: 16, end_s: 19 }, null,
    ]);
    expect(currentKaraokeLine(lines, 10.5)?.text).toBe("actual");
    expect(currentKaraokeLine(lines, 12.5)?.text).toBe("adlib");
    const repeated = currentKaraokeLine(lines, 16.5)!;
    expect(lexicalWords(repeated).map(part => part.timing)).toEqual([
      { start_s: 16, end_s: 17 }, null, { start_s: 18, end_s: 19 }, null,
    ]);
    expect(lines.find(line => line.text === "Unknown refrain")?.timing).toBeNull();
    const [position, setPosition] = createSignal(10.5);
    render(() => <TimelineKaraoke job={source} position={position()} />);
    const region = screen.getByRole("region", { name: "Current karaoke line" });
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent(/^actual$/);
    setPosition(16.5);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent(/^Go, go—don't stop!$/);
    expect(region.querySelector("[aria-current]")).toHaveTextContent("Go");
    setPosition(12.5);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent(/^adlib$/);
    expect(region.querySelector("[aria-current]")).toHaveTextContent("adlib");
  });

  it("previews a second early, holds across gaps/end, and recomputes immediately after backward seeks", () => {
    const lines = karaokeLines(job());
    expect(currentKaraokeLine(lines, 2.99)).toBeNull();
    expect(currentKaraokeLine(lines, 3)?.timing?.start_s).toBe(4);
    expect(currentKaraokeLine(lines, 6.99)?.timing?.start_s).toBe(4);
    expect(currentKaraokeLine(lines, 7)?.timing?.start_s).toBe(8);
    expect(currentKaraokeLine(lines, 24)?.timing?.start_s).toBe(8);
    expect(currentKaraokeLine(lines, 4)?.timing?.start_s).toBe(4);
    expect(currentKaraokeLine(lines, 0)).toBeNull();
    const source = job();
    source.transcript!.words![2] = word("Go", 15, 16.25);
    source.transcript!.words![3] = word("don't", 17.5, 18.75);
    source.transcript!.reference!.lines![1] = referenceLine("Go, go—don't stop!", 15, 18.75);
    expect(currentKaraokeLine(karaokeLines(source), 10)?.timing?.start_s).toBe(4);
  });

  it("never replaces a still-sung line for the next line's anticipatory lead", () => {
    const source = job();
    source.transcript!.words![2] = word("Go", 8.125, 10);
    source.transcript!.reference!.lines![1] = referenceLine("Go, go—don't stop!", 8.125, 13.75);
    const lines = karaokeLines(source);
    expect(currentKaraokeLine(lines, 6.75)?.timing?.start_s).toBe(4);
    expect(currentKaraokeLine(lines, 7)?.timing?.start_s).toBe(6.5);
  });

  it("uses known word extent instead of contradictory supported phrase bounds", () => {
    const source = job();
    source.transcript!.reference!.lines![0] = referenceLine("Go, go—don't stop!", 6.25, 7.5);
    const line = karaokeLines(source)[0];
    expect(line.timing).toEqual({ start_s: 4, end_s: 7 });
    expect(karaokeWordState(lexicalWords(line)[1].timing, 4.5).state).toBe("active");
    expect(karaokeWordState(lexicalWords(line)[2].timing, 6.5).state).toBe("active");
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

  it("keeps segment repeats separate and leaves ambiguous missing repeated words neutral", () => {
    const source = job();
    source.transcript!.reference = null;
    source.transcript!.segments = [
      { text: "Go go home!", start_s: 5, end_s: 8.75 },
      { text: "Go go home!", start_s: 10, end_s: 13.75 },
    ];
    source.transcript!.words = [word("go", 5, 6.25), word("home", 7.5, 8.75),
      word("Go", 10, 11.25), word("go", 11.25, 12.5), word("home", 12.5, 13.75)];
    const lines = karaokeLines(source);
    expect(lexicalWords(lines[0]).map(part => part.timing)).toEqual([null, null, { start_s: 6, end_s: 7 }]);
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

  it("links only unambiguous projected word identities, not filtered transcript indices or repeated text", () => {
    const source = job();
    source.pitch!.words = [
      word("unrelated", 1, 2), word("Go", 8, 9), word("go", 4, 5),
      word("don't", 6, 7), word("don't", 6, 7),
      { ...word("don't", 10, 11), origin: "asr" },
    ];
    const lines = karaokeLines(source);
    expect(lexicalWords(lines[0]).map(part => part.pitchIndex)).toEqual([undefined, 2, undefined, undefined]);
    expect(lexicalWords(lines[1]).map(part => part.pitchIndex)).toEqual([1, undefined, undefined, undefined]);
    source.transcript!.words!.push(word("go", 5, 6.25));
    expect(lexicalWords(karaokeLines(source)[0])[1].pitchIndex).toBeUndefined();
  });

  it("retains direct pitch indices for historical pitch-only words", () => {
    const source = job();
    source.transcript = null;
    source.pitch!.words = [word("same", 4, 5), word("same", 6, 7)];
    expect(karaokeLines(source).map(line => lexicalWords(line)[0].pitchIndex)).toEqual([0, 1]);
  });
});

describe("TimelineKaraoke reactive reader", () => {
  it("shows the actual active word, neutral unknown slots and no active word during a gap", () => {
    const [position, setPosition] = createSignal(3);
    render(() => <TimelineKaraoke job={job()} position={position()} />);
    const region = screen.getByRole("region", { name: "Current karaoke line" });
    expect(region).toHaveAttribute("aria-live", "off");
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent(/^Go, go—don't stop!$/);
    expect(screen.getByRole("group", { name: "Next lyrics" })).toHaveTextContent(/^Go, go—don't stop!$/);
    expect(region.querySelector("[aria-current]")).toBeNull();
    setPosition(4.5);
    expect(region.querySelector("[aria-current]")).toHaveTextContent(/^go$/);
    expect([...screen.getByRole("group", { name: "Current lyrics" }).querySelectorAll('[data-state="untimed"]')].map(word => word.textContent)).toEqual(["Go", "stop"]);
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
    expect(region.querySelector("[aria-current]")).toBeNull();
    expect(region.querySelector('[data-state="pending"]')).toHaveTextContent(/^Go$/);
    setPosition(8.5);
    expect(region.querySelector("[aria-current]")).toHaveTextContent(/^Go$/);
    setPosition(24);
    expect(region.querySelectorAll('[data-state="complete"]')).toHaveLength(2);
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

  it.each(["canonical", "segment"] as const)("keeps a partial %s phrase visible through its supported untimed tail", kind => {
    const source = job();
    const text = "Before known after";
    source.transcript!.words = [word("known", 6.25, 7.5), word("Next", 11.875, 13.125)];
    source.transcript!.canonical_word_positions = [
      { word_index: 0, reference_line_index: 0, reference_token_index: 1 },
      { word_index: 1, reference_line_index: 1, reference_token_index: 0 },
    ];
    source.transcript!.reference!.lines = [referenceLine(text, 5, 11.25), referenceLine("Next", 11.875, 13.125)];
    if (kind === "segment") {
      source.transcript!.reference = null;
      source.transcript!.segments = [
        { text, start_s: 5, end_s: 11.25 }, { text: "Next", start_s: 11.875, end_s: 13.125 },
      ];
    }
    const lines = karaokeLines(source);
    expect(lines[0].timing).toEqual({ start_s: 4, end_s: 9 });
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
    expect(region.querySelector("[aria-current]")).toBeNull();
    expect([...screen.getByRole("group", { name: "Current lyrics" }).querySelectorAll('[data-state="untimed"]')].map(word => word.textContent)).toEqual(["Before", "after"]);
    setPosition(9);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toHaveTextContent("Next");
    expect(region.querySelector("[aria-current]")).toBeNull();
    setPosition(9.75);
    expect(region.querySelector("[aria-current]")).toHaveTextContent("Next");
  });

  it("renders only the selected stem's linked pitches above their words and toggles them", () => {
    const source = job();
    source.pitch!.words = [word("go", 4, 5), word("Go", 8, 9)];
    const note = { start_s: 4, end_s: 5, midi: 60, frequency_hz: 261.6, note: "C4", cents: 0, confidence: 0.9, word_indices: [0] };
    const [notes, setNotes] = createSignal([note, { ...note, note: "D4" }]);
    render(() => <TimelineKaraoke job={source} position={4.5} notes={notes()} />);
    const current = screen.getByRole("group", { name: "Current lyrics" });
    expect(within(current).getByText("C4 D4")).toBeVisible();
    expect(within(current).getByText("go", { exact: true }).closest(".timeline-karaoke-cell")).toContainElement(within(current).getByText("C4 D4"));
    setNotes([{ ...note, note: "G4" }]);
    expect(within(current).getByText("G4")).toBeVisible();
    expect(within(current).queryByText("C4 D4")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Pitches" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(within(current).queryByText("G4")).not.toBeInTheDocument();
    expect(within(current).getByText("go", { exact: true })).toBeVisible();
  });

  it("keeps repeated-word pitch sequences with their own occurrence through promotion and toggling", () => {
    const source = job();
    source.pitch!.words = [word("go", 4, 5), word("Go", 8, 9)];
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
    expect(within(current).getByRole("group", { name: "Pitches for go: C#4 D#4" }).parentElement)
      .toContainElement(within(current).getByText("go", { exact: true }));
    expect(within(current).getByText("go", { exact: true }).parentElement).toHaveTextContent(/^go—$/);
    expect(within(next).getByRole("group", { name: "Pitches for Go: F#5" }).parentElement)
      .toContainElement(within(next).getByText("Go", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
    expect(within(current).queryByRole("group", { name: /Pitches for/ })).not.toBeInTheDocument();
    expect(within(next).queryByRole("group", { name: /Pitches for/ })).not.toBeInTheDocument();
    setPosition(8.5);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toBe(next);
    expect(within(next).getByText("Go", { exact: true })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "Pitches" }));
    expect(within(next).getByRole("group", { name: "Pitches for Go: F#5" })).toBeVisible();
    expect(within(next).queryByRole("group", { name: /C#4/ })).not.toBeInTheDocument();
  });

  it("promotes the existing next row on adjacent playback but not by a seek", () => {
    const [position, setPosition] = createSignal(6.9);
    const [seeking, setSeeking] = createSignal(false);
    const [revision, setRevision] = createSignal(0);
    render(() => <TimelineKaraoke job={job()} position={position()} playing seeking={seeking()} seekRevision={revision()} />);
    const next = screen.getByRole("group", { name: "Next lyrics" });
    setPosition(6.99);
    setPosition(7);
    expect(screen.getByRole("group", { name: "Current lyrics" })).toBe(next);
    expect(next).toHaveClass("timeline-karaoke-slide");
    setSeeking(true);
    setRevision(1);
    setPosition(4.5);
    expect(screen.getByRole("group", { name: "Current lyrics" })).not.toHaveClass("timeline-karaoke-slide");
    setPosition(7);
    expect(screen.getByRole("group", { name: "Current lyrics" })).not.toHaveClass("timeline-karaoke-slide");
  });
});
