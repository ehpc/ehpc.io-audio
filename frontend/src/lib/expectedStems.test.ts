import { describe, expect, it } from "vitest";
import type { SeparationOptions } from "~/api";
import { displayOutputLabel, expectedStems } from "./expectedStems";

const NONE: SeparationOptions = {
  extract_vocals: false, extract_instruments: false,
  mix_female_instruments: false, mix_male_instruments: false, mix_backing_instruments: false,
  decrowd: false, decrowd_vocals: false, dereverb: false, genders: false,
  lead_backing: false, drums: false, no_cache: false,
  pitch_semitones: 0, tempo_percent: 100,
};

describe("expectedStems", () => {
  it("defaults to no stems, song transformation output, and dereverb fallback", () => {
    expect(expectedStems(NONE)).toEqual([]);
    expect(expectedStems({ ...NONE, pitch_semitones: 2 })).toEqual(["song"]);
    expect(expectedStems({ ...NONE, dereverb: true })).toEqual(["vocals-dry"]);
    expect(expectedStems({ ...NONE, extract_instruments: true, dereverb: true })).toEqual(["instruments"]);
  });

  it("outputs only explicitly selected extracts and mix labels", () => {
    expect(expectedStems({ ...NONE, extract_vocals: true })).toEqual(["vocals"]);
    expect(expectedStems({ ...NONE, extract_instruments: true })).toEqual(["instruments"]);
    expect(expectedStems({ ...NONE, mix_female_instruments: true })).toEqual(["female-instruments"]);
    expect(expectedStems({ ...NONE, mix_male_instruments: true })).toEqual(["male-instruments"]);
    expect(expectedStems({ ...NONE, mix_backing_instruments: true })).toEqual(["backing-instruments"]);
  });

  it("produces no -dry stems when dereverb is off", () => {
    const labels = expectedStems({ ...NONE, genders: true, lead_backing: true });
    expect(labels.some((l) => l.endsWith("-dry"))).toBe(false);
  });

  it("keeps wet/dry pairs adjacent, followed by instruments and mixes", () => {
    const all: SeparationOptions = {
      ...NONE,
      extract_vocals: true,
      extract_instruments: true,
      mix_female_instruments: true,
      mix_male_instruments: true,
      mix_backing_instruments: true,
      decrowd: true,
      decrowd_vocals: true,
      dereverb: true,
      genders: true,
      lead_backing: true,
      drums: true,
      no_cache: false,
      pitch_semitones: 0,
      tempo_percent: 100,
    };
    expect(expectedStems(all)).toEqual([
      "vocals",
      "vocals-dry",
      "vocals-decrowded",
      "vocals-decrowded-dry",
      "vocals-male",
      "vocals-male-dry",
      "vocals-female",
      "vocals-female-dry",
      "lead",
      "lead-dry",
      "backing",
      "backing-dry",
      "instruments",
      "instruments-decrowded",
      "drums",
      "bass",
      "other-instruments",
      "female-instruments",
      "male-instruments",
      "backing-instruments",
    ]);
  });

  it("cleans mix prerequisites without exposing their stems", () => {
    expect(expectedStems({
      ...NONE, dereverb: true,
      mix_female_instruments: true, mix_male_instruments: true, mix_backing_instruments: true,
    })).toEqual(["female-instruments", "male-instruments", "backing-instruments"]);
    expect(expectedStems({ ...NONE, drums: true })).toEqual(["drums", "bass", "other-instruments"]);
    expect(expectedStems({ ...NONE, decrowd: true })).toEqual(["instruments-decrowded"]);
    expect(expectedStems({ ...NONE, tempo_percent: 80, no_cache: true })).toEqual(["song"]);
  });
});

describe("displayOutputLabel", () => {
  it("shows only modified settings on outputs, preserving the original", () => {
    expect(displayOutputLabel("song", NONE)).toBe("Full song");
    expect(displayOutputLabel("original", { ...NONE, pitch_semitones: 2, tempo_percent: 120 }))
      .toBe("Original (unchanged)");
    expect(displayOutputLabel("song", { ...NONE, pitch_semitones: 2 }))
      .toBe("Full song (pitch +2 st)");
    expect(displayOutputLabel("vocals", { ...NONE, tempo_percent: 120 }))
      .toBe("vocals (tempo 120%)");
    expect(displayOutputLabel("vocals", { ...NONE, pitch_semitones: -2.5, tempo_percent: 85 }))
      .toBe("vocals (pitch -2.5 st, tempo 85%)");
  });
});
