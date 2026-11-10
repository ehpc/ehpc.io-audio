import type { PitchNoteDTO } from "~/api";

export const PIANO_WHITE_WIDTH = 40;
export const PIANO_BLACK_WIDTH = 26;
const blackClasses = new Set([1, 3, 6, 8, 10]);

export interface PianoKey {
  midi: number;
  black: boolean;
  left: number;
}

// Stable identities keep held buttons mounted when the visible range changes.
const allKeys: PianoKey[] = [];
const whites: PianoKey[] = [];
for (let midi = 0; midi <= 127; midi++) {
  const black = blackClasses.has(midi % 12);
  const key = { midi, black, left: black ? whites.length * PIANO_WHITE_WIDTH - PIANO_BLACK_WIDTH / 2 : whites.length * PIANO_WHITE_WIDTH };
  allKeys.push(key);
  if (!black) whites.push(key);
}

export interface PianoLayout {
  keys: PianoKey[];
  left: number;
  width: number;
  center: number;
}

export function pianoLayout(notes: readonly PitchNoteDTO[], viewportWidth: number): PianoLayout {
  let low = 127;
  let high = 0;
  let found = false;
  for (const note of notes) {
    if (!Number.isFinite(note.midi) || note.midi < 0 || note.midi > 127) continue;
    const midi = Math.round(note.midi);
    low = Math.min(low, midi);
    high = Math.max(high, midi);
    found = true;
  }
  if (!found) { low = 60; high = 83; }
  const minKey = allKeys[low];
  const maxKey = allKeys[high];
  const center = (minKey.left + (minKey.black ? PIANO_BLACK_WIDTH : PIANO_WHITE_WIDTH) / 2 + maxKey.left + (maxKey.black ? PIANO_BLACK_WIDTH : PIANO_WHITE_WIDTH) / 2) / 2;
  let first = Math.max(0, Math.floor(minKey.left / PIANO_WHITE_WIDTH));
  let last = Math.min(whites.length - 1, Math.ceil((maxKey.left + (maxKey.black ? PIANO_BLACK_WIDTH : PIANO_WHITE_WIDTH)) / PIANO_WHITE_WIDTH) - 1);
  const capacity = Math.max(1, Math.floor(viewportWidth / PIANO_WHITE_WIDTH));
  while (last - first + 1 < capacity && (first > 0 || last < whites.length - 1)) {
    const leftDistance = first > 0 ? Math.abs(((first - 1 + last + 1) * PIANO_WHITE_WIDTH / 2) - center) : Infinity;
    const rightDistance = last < whites.length - 1 ? Math.abs(((first + last + 2) * PIANO_WHITE_WIDTH / 2) - center) : Infinity;
    if (leftDistance <= rightDistance) first--;
    else last++;
  }
  const left = first * PIANO_WHITE_WIDTH;
  return { keys: allKeys.slice(whites[first].midi, whites[last].midi + 1), left, width: (last - first + 1) * PIANO_WHITE_WIDTH, center: center - left };
}
