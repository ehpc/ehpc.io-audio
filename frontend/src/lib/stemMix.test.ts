import { describe, expect, it } from "vitest";
import { mixIdValid, nextMixId, stemLabel, stemMixError, stemMixKey, stemMixName, STEM_COMPONENTS } from "./stemMix";
import type { StemMix } from "./stemMix";

const MIX = (id: string, components: StemMix["components"], name?: string): StemMix => ({
  id, name: name ?? components.join(" + "), components,
});

describe("stemMix catalog", () => {
  it("exposes the five main parts and the four collapsed vocal variants", () => {
    expect(STEM_COMPONENTS.filter((c) => c.family === "main").map((c) => c.label)).toEqual([
      "Drums", "Bass", "Vocals", "Other instruments", "Instruments",
    ]);
    expect(STEM_COMPONENTS.filter((c) => c.family === "vocal-variant").map((c) => c.label)).toEqual([
      "Female vocals", "Male vocals", "Lead vocals", "Backing vocals",
    ]);
  });

  it("uses the contract component ids", () => {
    expect(STEM_COMPONENTS.map((c) => c.id)).toEqual([
      "drums", "bass", "vocals", "other", "instruments", "female", "male", "lead", "backing",
    ]);
  });
});

describe("stemMixName", () => {
  it("names all four approved example pairs from components", () => {
    expect(stemMixName(["drums", "bass"])).toBe("Drums + Bass");
    expect(stemMixName(["drums", "vocals"])).toBe("Drums + Vocals");
    expect(stemMixName(["bass", "vocals"])).toBe("Bass + Vocals");
    expect(stemMixName(["drums", "other"])).toBe("Drums + Other instruments");
  });

  it("names mixes of three or more parts and vocal variants", () => {
    expect(stemMixName(["drums", "bass", "vocals"])).toBe("Drums + Bass + Vocals");
    expect(stemMixName(["female", "instruments"])).toBe("Female vocals + Instruments");
  });

  it("falls back to the raw id for unknown components instead of crashing", () => {
    expect(stemLabel("mystery-part" as never)).toBe("mystery-part");
  });
});

describe("stemMixError", () => {
  it("requires 2+ unique components", () => {
    expect(stemMixError(MIX("mix-1", ["drums", "bass"]))).toBeNull();
    expect(stemMixError(MIX("mix-1", ["drums", "drums"]))).toMatch(/same part twice/);
    expect(stemMixError(MIX("mix-1", ["drums"]))).toMatch(/at least 2/);
  });

  it("requires a non-empty trimmed name within 120 characters", () => {
    expect(stemMixError(MIX("mix-1", ["drums", "bass"], "  My groove  "))).toBeNull();
    expect(stemMixError(MIX("mix-1", ["drums", "bass"], "   "))).toMatch(/needs a name/);
    expect(stemMixError(MIX("mix-1", ["drums", "bass"], "x".repeat(121)))).toMatch(/120/);
    expect(stemMixError(MIX("mix-1", ["drums", "bass"], "x".repeat(120)))).toBeNull();
  });
});

describe("mix ids", () => {
  it("accepts the contract id shape", () => {
    expect(mixIdValid("mix-1")).toBe(true);
    expect(mixIdValid("mix-42-longer-tag")).toBe(true);
    expect(mixIdValid("mix-")).toBe(false);
    expect(mixIdValid("mix-UPPER")).toBe(false);
    expect(mixIdValid("1mix")).toBe(false);
  });

  it("assigns short monotonic ids that are never reused after removal", () => {
    expect(nextMixId([])).toBe("mix-1");
    expect(nextMixId([MIX("mix-1", ["drums", "bass"]), MIX("mix-2", ["bass", "vocals"])])).toBe("mix-3");
    // mix-2 was removed: with the issued floor, mix-2 is not freed for reuse.
    expect(nextMixId([MIX("mix-1", ["drums", "bass"])])).toBe("mix-2");
    expect(nextMixId([MIX("mix-1", ["drums", "bass"])], 2)).toBe("mix-3");
    expect(nextMixId([MIX("mix-1", ["drums", "bass"]), MIX("mix-3", ["bass", "vocals"])]))
      .toBe("mix-4");
  });
});

describe("stemMixKey", () => {
  it("is order-independent so duplicate sets compare equal", () => {
    expect(stemMixKey(["bass", "drums"])).toBe(stemMixKey(["drums", "bass"]));
    expect(stemMixKey(["drums", "bass"])).not.toBe(stemMixKey(["drums", "vocals"]));
  });
});
