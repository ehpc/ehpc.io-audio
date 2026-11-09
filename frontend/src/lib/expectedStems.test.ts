import { describe, expect, it } from "vitest";
import type { BooleanOptionKey, SeparationOptions, StemManifestEntry } from "~/api";
import { displayOutputLabel, expectedPitchStems, expectedStems, manifestOutputLabel } from "./expectedStems";
import type { StemMix } from "./stemMix";

const NONE: SeparationOptions = {
  extract_vocals: false, extract_instruments: false,
  extract_lyrics: false,
  detect_pitch: false,
  extract_pitched_lyrics: false,
  mixes: [],
  decrowd: false, decrowd_vocals: false, dereverb: false, genders: false,
  lead_backing: false, drums: false,
  pitch_semitones: 0, tempo_percent: 100,
};

const MIX = (id: string, components: StemMix["components"], name?: string): StemMix => ({
  id, name: name ?? components.join(" + "), components,
});

describe("expectedStems", () => {
  it("counts one pitched TXT per analyzed vocal output without adding hidden audio", () => {
    expect(expectedPitchStems(NONE)).toEqual([]);
    expect(expectedPitchStems({ ...NONE, extract_pitched_lyrics: true })).toEqual(["vocals"]);
    expect(expectedStems({ ...NONE, extract_pitched_lyrics: true })).toEqual([]);
    expect(expectedPitchStems({ ...NONE, extract_pitched_lyrics: true, lead_backing: true, dereverb: true })).toEqual(["lead", "lead-dry", "backing", "backing-dry"]);
    expect(expectedPitchStems({ ...NONE, extract_pitched_lyrics: true, extract_instruments: true })).toEqual(["vocals"]);
    expect(expectedPitchStems({ ...NONE, extract_pitched_lyrics: true, mixes: [MIX("mix-1", ["female", "instruments"])] })).toEqual(["vocals"]);
  });
  it("does not treat lyrics as an audio stem", () => {
    expect(expectedStems({ ...NONE, extract_lyrics: true })).toEqual([]);
    expect(expectedStems({ ...NONE, extract_lyrics: true, extract_vocals: true })).toEqual(["vocals"]);
  });
  it("defaults to no stems, song transformation output, and dereverb fallback", () => {
    expect(expectedStems(NONE)).toEqual([]);
    expect(expectedStems({ ...NONE, pitch_semitones: 2 })).toEqual(["song"]);
    expect(expectedStems({ ...NONE, dereverb: true })).toEqual(["vocals-dry"]);
    expect(expectedStems({ ...NONE, extract_instruments: true, dereverb: true })).toEqual(["instruments"]);
  });

  it("outputs only explicitly selected extracts", () => {
    expect(expectedStems({ ...NONE, extract_vocals: true })).toEqual(["vocals"]);
    expect(expectedStems({ ...NONE, extract_instruments: true })).toEqual(["instruments"]);
    expect(expectedStems({ ...NONE, drums: true })).toEqual(["drums", "bass", "other-instruments"]);
    expect(expectedStems({ ...NONE, decrowd: true })).toEqual(["instruments-decrowded"]);
    expect(expectedStems({ ...NONE, tempo_percent: 80 })).toEqual(["song"]);
  });

  it("adds the canonical karaoke backing only while karaoke is selected", () => {
    const karaoke = { ...NONE, detect_pitch: true, pitch_semitones: 2, tempo_percent: 125 };
    expect(expectedStems(karaoke)).toEqual(["song", "drums-vocals"]);
    expect(expectedStems({ ...karaoke, detect_pitch: false })).toEqual(["song"]);
    expect(expectedStems({ ...NONE, extract_pitched_lyrics: true })).toEqual([]);
    expect(displayOutputLabel("drums-vocals", karaoke)).toBe("Drums + Vocals (pitch +2 st, tempo 125%)");
    expect(expectedStems({ ...karaoke, dereverb: true, mixes: [MIX("mix-1", ["vocals", "drums"], "My backing")] }))
      .toEqual(["song", "drums-vocals", "mix-1"]);
  });

  it("emits one result per queued mix, labelled by its stable id", () => {
    expect(expectedStems({ ...NONE, mixes: [MIX("mix-1", ["drums", "bass"]), MIX("mix-2", ["bass", "vocals"])] }))
      .toEqual(["mix-1", "mix-2"]);
    expect(expectedStems({
      ...NONE, mixes: [MIX("mix-7", ["drums", "bass"])], dereverb: true, pitch_semitones: 1.25, tempo_percent: 125,
    })).toEqual(["song", "mix-7"]);
  });

  it("treats mixes as real selections, so dereverb does not fall back to vocals-dry", () => {
    expect(expectedStems({ ...NONE, dereverb: true, mixes: [MIX("mix-1", ["drums", "bass"])] })).toEqual(["mix-1"]);
    expect(expectedStems({ ...NONE, dereverb: true })).toEqual(["vocals-dry"]);
  });

  it("keeps wet/dry pairs adjacent, followed by mixes", () => {
    const all: SeparationOptions = {
      ...NONE,
      extract_vocals: true,
      extract_instruments: true,
      mixes: [MIX("mix-1", ["drums", "bass"]), MIX("mix-2", ["female", "instruments"])],
      decrowd: true,
      decrowd_vocals: true,
      dereverb: true,
      genders: true,
      lead_backing: true,
      drums: true,
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
      "mix-1",
      "mix-2",
    ]);
  });

  it("keeps the exact public-output contract for all 2048 boolean selections", () => {
    const flags = (Object.keys(NONE) as (keyof SeparationOptions)[]).filter((key) =>
      key !== "extract_lyrics" && key !== "detect_pitch" && key !== "extract_pitched_lyrics"
      && key !== "mixes" && typeof NONE[key] === "boolean",
    ) as BooleanOptionKey[];
    const outputs: [string, BooleanOptionKey, boolean][] = [
      ["vocals", "extract_vocals", true],
      ["vocals-decrowded", "decrowd_vocals", true],
      ["vocals-male", "genders", true],
      ["vocals-female", "genders", true],
      ["lead", "lead_backing", true],
      ["backing", "lead_backing", true],
      ["instruments", "extract_instruments", false],
      ["instruments-decrowded", "decrowd", false],
      ["drums", "drums", false],
      ["bass", "drums", false],
      ["other-instruments", "drums", false],
    ];
    for (let mask = 0; mask < 2 ** flags.length; mask++) {
      const options = { ...NONE };
      flags.forEach((flag, index) => { options[flag] = Boolean(mask & (1 << index)); });
      const expected = outputs.flatMap(([label, flag, vocal]) =>
        options[flag] ? (vocal && options.dereverb ? [label, `${label}-dry`] : [label]) : [],
      );
      if (options.dereverb && expected.length === 0) expected.push("vocals-dry");
      expect(expectedStems(options), `selection ${mask}`).toEqual(expected);
      expect(expectedStems({ ...options, pitch_semitones: -2.5, tempo_percent: 80 }), `transformed selection ${mask}`)
        .toEqual(["song", ...expected]);
    }
  });

  it("adds one pitched full source ahead of selected outputs without broadening tempo-only jobs", () => {
    for (const pitch_semitones of [-12, -0.125, 0.000001, 12]) {
      expect(expectedStems({ ...NONE, extract_instruments: true, pitch_semitones, tempo_percent: 125 }))
        .toEqual(["song", "instruments"]);
      expect(expectedStems({ ...NONE, pitch_semitones })).toEqual(["song"]);
    }
    expect(expectedStems({ ...NONE, extract_instruments: true, tempo_percent: 125 })).toEqual(["instruments"]);
    expect(expectedStems({ ...NONE, dereverb: true, pitch_semitones: -0.5 })).toEqual(["song", "vocals-dry"]);
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

  it("resolves mix ids to their mix names, never raw component labels", () => {
    const options: SeparationOptions = { ...NONE, mixes: [MIX("mix-1", ["drums", "bass"], "My groove")] };
    expect(displayOutputLabel("mix-1", options)).toBe("My groove");
    expect(displayOutputLabel("mix-1", { ...options, pitch_semitones: 2 })).toBe("My groove (pitch +2 st)");
    // Unknown ids (historical jobs) fall back to the raw legacy label.
    expect(displayOutputLabel("mix-1", NONE)).toBe("mix-1");
  });
});

describe("manifestOutputLabel", () => {
  it("uses server mix names and appends pitch/tempo adjustments", () => {
    const stem: StemManifestEntry = { label: "mix-1", display_name: "My groove", filename: "mix-1.mp3", download_name: "My groove - mix-1.mp3", size_bytes: 1, duration_s: 1 };
    const options = { ...NONE, mixes: [MIX("mix-1", ["drums", "bass"], "My groove")], pitch_semitones: 1.25, tempo_percent: 125 };
    expect(manifestOutputLabel(stem, options)).toBe("My groove (pitch +1.25 st, tempo 125%)");
  });

  it("renders transformed song manifests as Full song with adjustments", () => {
    const stem: StemManifestEntry = { label: "song", display_name: "song", filename: "song.mp3", download_name: "Title - Full song - source-key - pitch+1.25st-tempo125pct.mp3", size_bytes: 1, duration_s: 1 };
    expect(manifestOutputLabel(stem, { ...NONE, pitch_semitones: 1.25, tempo_percent: 125 }))
      .toBe("Full song (pitch +1.25 st, tempo 125%)");
  });

  it("falls back to the label for historical payloads without display names", () => {
    const stem: StemManifestEntry = { label: "female-instruments", filename: "female-instruments.mp3", download_name: "song - female-instruments.mp3", size_bytes: 1, duration_s: 1 };
    expect(manifestOutputLabel(stem, NONE)).toBe("female-instruments");
  });
});
