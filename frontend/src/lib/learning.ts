import type { LearningHint } from "~/api";

export interface StudyPart {
  text: string;
  word: boolean;
}

// Study hints follow typographic words and grapheme clusters, not acoustic tokens.
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function studyParts(text: string): StudyPart[] {
  return Array.from(words.segment(text), part => ({ text: part.segment, word: Boolean(part.isWordLike) }));
}

export function studyHint(text: string, level: LearningHint): string {
  if (level === "full") return text;
  const clusters = Array.from(graphemes.segment(text), part => part.segment);
  const visible = level === "partial" ? Math.ceil(clusters.length / 2) : level === "first" ? 1 : 0;
  return clusters.slice(0, visible).join("") + "•".repeat(Math.max(1, clusters.length - visible));
}
