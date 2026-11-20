import { describe, expect, it } from "vitest";
import { studyHint, studyParts } from "./learning";

describe("study word and grapheme hints", () => {
  it("keeps decomposed accents and emoji clusters intact", () => {
    const text = "e\u0301lan 東京 👩‍👩‍👧‍👦";
    const parts = studyParts(text);
    expect(parts.map(part => part.text).join("")).toBe(text);
    expect(studyHint("e\u0301lan", "first")).toBe("e\u0301•••");
    expect(studyHint("e\u0301lan", "partial")).toBe("e\u0301l••");
    expect(studyHint("e\u0301lan", "hidden")).toBe("••••");
    expect(studyHint("東京", "first")).toBe("東•");
  });
});
