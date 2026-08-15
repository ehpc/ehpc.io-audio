import { describe, expect, it } from "vitest";
import type { SeparationOptions } from "~/api";
import { expectedStems } from "./expectedStems";

const NONE: SeparationOptions = {
  decrowd: false,
  dereverb: false,
  genders: false,
  lead_backing: false,
  drums: false,
  no_cache: false,
};

describe("expectedStems", () => {
  it("returns vocals + instruments by default", () => {
    expect(expectedStems(NONE)).toEqual(["vocals", "instruments"]);
  });

  it("pairs the dry stem next to vocals", () => {
    expect(expectedStems({ ...NONE, dereverb: true })).toEqual([
      "vocals",
      "vocals-dry",
      "instruments",
    ]);
  });

  it("produces no -dry stems when dereverb is off", () => {
    const labels = expectedStems({ ...NONE, genders: true, lead_backing: true });
    expect(labels.some((l) => l.endsWith("-dry"))).toBe(false);
  });

  // Must match separator/stems.py's run_separation order exactly (see the
  // backend's test_stems.py). A split emits both wet stems together, then both
  // dry stems.
  it("orders all options with wet groups followed by their dry stems", () => {
    const all: SeparationOptions = {
      decrowd: true,
      dereverb: true,
      genders: true,
      lead_backing: true,
      drums: true,
      no_cache: false,
    };
    expect(expectedStems(all)).toEqual([
      "vocals",
      "vocals-dry",
      "vocals-male",
      "vocals-female",
      "vocals-male-dry",
      "vocals-female-dry",
      "lead",
      "backing",
      "lead-dry",
      "backing-dry",
      "instruments",
      "instruments-decrowded",
      "drums",
      "bass",
      "other-instruments",
    ]);
  });
});
