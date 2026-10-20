import { describe, expect, it } from "vitest";
import { keyScale, transposeKey } from "./music";

describe("diatonic key notes", () => {
  it.each([
    ["C major", "major", ["C", "D", "E", "F", "G", "A", "B"]],
    ["G major", "major", ["G", "A", "B", "C", "D", "E", "F#"]],
    ["F major", "major", ["F", "G", "A", "Bb", "C", "D", "E"]],
    ["Db major", "major", ["Db", "Eb", "F", "Gb", "Ab", "Bb", "C"]],
    ["Gb major", "major", ["Gb", "Ab", "Bb", "Cb", "Db", "Eb", "F"]],
    ["A minor", "natural minor", ["A", "B", "C", "D", "E", "F", "G"]],
    ["B minor", "natural minor", ["B", "C#", "D", "E", "F#", "G", "A"]],
    ["F minor", "natural minor", ["F", "G", "Ab", "Bb", "C", "Db", "Eb"]],
    ["Gb minor", "natural minor", ["Gb", "Ab", "Bbb", "Cb", "Db", "Ebb", "Fb"]],
    ["D major (+25 cents)", "major", ["D", "E", "F#", "G", "A", "B", "C#"]],
  ])("spells %s as %s", (key, mode, notes) => {
    expect(keyScale(key as string)).toEqual({ mode, notes });
  });

  it("does not invent notes for unknown keys", () => {
    expect(keyScale(null)).toBeNull();
    expect(keyScale("Undetermined")).toBeNull();
  });
});

describe("target key", () => {
  it.each([
    ["C major", 0, "C major"],
    ["C major", 2, "D major"],
    ["B minor", 2, "Db minor"],
    ["Db minor", -25, "C minor"],
    ["C major", 2.25, "D major (+25 cents)"],
    ["C major", -0.25, "C major (-25 cents)"],
    ["C major", 1.75, "D major (-25 cents)"],
    ["C# minor", 12.001, "Db minor (+0.1 cents)"],
    ["C major", -0.5, "B major (+50 cents)"],
    ["C major", 0.5, "Db major (-50 cents)"],
    ["C major", -0.49999999999999994, "C major (-49.999999999999994 cents)"],
    ["C major", 1e-7, "C major (+0.00001 cents)"],
  ])("transposes %s by %s", (original, pitch, target) => {
    expect(transposeKey(original as string, pitch as number)).toBe(target);
  });

  it("leaves an unknown or invalid preview unknown", () => {
    expect(transposeKey(null, 2)).toBeNull();
    expect(transposeKey("C major", Number.NaN)).toBeNull();
  });
});
