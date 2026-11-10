import { expect, it } from "vitest";
import type { PitchNoteDTO } from "~/api";
import { pianoLayout, PIANO_BLACK_WIDTH, PIANO_WHITE_WIDTH } from "./pianoLayout";

const note = (midi: number): PitchNoteDTO => ({ midi, start_s: 0, end_s: 1, frequency_hz: 440, note: "", cents: 0, confidence: 1, word_indices: [] });

it("fills wide and narrow viewports with readable keys centered on a short song", () => {
  const notes = [note(60), note(64)];
  const narrow = pianoLayout(notes, 390);
  const wide = pianoLayout(notes, 1440);
  for (const [layout, viewport] of [[narrow, 390], [wide, 1440]] as const) {
    expect(layout.width).toBeLessThanOrEqual(viewport);
    expect(viewport - layout.width).toBeLessThan(PIANO_WHITE_WIDTH);
    expect(layout.keys.map(key => key.midi)).toEqual(expect.arrayContaining([60, 64]));
  }
  expect(wide.keys.length).toBeGreaterThan(narrow.keys.length);
  expect(Math.abs(wide.center - wide.width / 2)).toBeLessThanOrEqual(PIANO_WHITE_WIDTH / 2);
});

it("retains the whole large song span including black-key edges and MIDI endpoints", () => {
  const black = pianoLayout([note(1), note(126)], 390);
  expect(black.width).toBeGreaterThan(390);
  expect(black.keys.map(key => key.midi)).toEqual(expect.arrayContaining([0, 1, 126, 127]));
  const edges = pianoLayout([note(0), note(127)], 390);
  expect(edges.keys[0].midi).toBe(0);
  expect(edges.keys.at(-1)?.midi).toBe(127);
  const firstBlack = black.keys.find(key => key.midi === 1)!;
  const lastBlack = black.keys.find(key => key.midi === 126)!;
  expect(firstBlack.left - black.left).toBeGreaterThanOrEqual(0);
  expect(lastBlack.left - black.left + PIANO_BLACK_WIDTH).toBeLessThanOrEqual(black.width);
});

it("centers a single sharp, ignores invalid notes and has a stable empty fallback", () => {
  const single = pianoLayout([note(61)], 400);
  expect(single.keys.some(key => key.midi === 61)).toBe(true);
  expect(Math.abs(single.center - single.width / 2)).toBeLessThanOrEqual(PIANO_WHITE_WIDTH / 2);
  const empty = pianoLayout([], 560);
  expect(pianoLayout([note(NaN), note(-4), note(200)], 560)).toEqual(empty);
  expect(empty.width).toBeLessThanOrEqual(560);
  expect(560 - empty.width).toBeLessThan(PIANO_WHITE_WIDTH);
  expect(empty.keys.every(key => key.midi >= 0 && key.midi <= 127)).toBe(true);
});
