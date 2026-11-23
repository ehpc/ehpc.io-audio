import type { JobDTO } from "~/api";
import { karaokeLines, type KaraokeTiming } from "./karaoke";

export type TimingHintLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type TimingSelection = readonly (readonly KaraokeTiming[])[];
export const TIMING_HINT_LABELS = ["Vocals off", "20% vocals", "40% vocals", "60% vocals", "80% vocals", "Full vocals"] as const;
export const FULL_TIMING_LEVEL: TimingHintLevel = 5;

/** Existing output-clock cues are context windows, not measured vocal boundaries. */
export function timingPracticeLines(job: Pick<JobDTO, "transcript" | "pitch" | "options" | "lyric_pitch_lines">): KaraokeTiming[] {
  const lines = karaokeLines(job);
  const projected = job.transcript?.presentation_lines;
  if (!projected) return [];
  const result: KaraokeTiming[] = [];
  let nextCanonical: number | undefined;
  const bounds: (KaraokeTiming | undefined)[] = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const cue = projected[i];
    const association = line.pitchAssociation;
    const start = line.timing?.start_s;
    if (start !== undefined && Number.isFinite(start)) {
      let end = association?.bounds_source !== "unknown" ? association?.end_s ?? undefined : undefined;
      if (end === undefined && cue.onset_s !== null && cue.end_s !== null && cue.end_s > cue.onset_s) {
        end = cue.end_s / ((job.pitch?.tempo_percent ?? job.options.tempo_percent) / 100);
      }
      if (end === undefined && cue.source_kind === "canonical" && nextCanonical !== undefined) end = nextCanonical;
      if (end !== undefined && Number.isFinite(end) && end > start) {
        bounds[i] = { start_s: start, end_s: Math.min(end, job.pitch?.duration_s ?? end) };
      }
    }
    if (cue.source_kind === "canonical") nextCanonical = line.timing?.start_s;
  }
  for (const bound of bounds) if (bound && bound.end_s > bound.start_s) result.push(bound);
  return result;
}

/** Shuffle disjoint one-second cells once per practice entry. */
export function timingSelection(lines: readonly KaraokeTiming[], random: () => number = Math.random): TimingSelection {
  return lines.map(line => {
    const duration = line.end_s - line.start_s;
    if (!Number.isFinite(line.start_s) || !Number.isFinite(line.end_s) || duration <= 0) return [];
    const count = Math.floor(duration);
    if (count === 0) return [{ start_s: line.start_s, end_s: line.end_s }];
    const offset = (duration - count) * Math.max(0, Math.min(1, random()));
    const cells = Array.from({ length: count }, (_, index) => {
      const start_s = line.start_s + offset + index;
      return { start_s, end_s: start_s + 1 };
    });
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(Math.max(0, random()) * (i + 1)));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    return cells;
  });
}

export function timingWindows(lines: readonly KaraokeTiming[], selection: TimingSelection, level: TimingHintLevel): KaraokeTiming[] {
  if (level === 0 || level === FULL_TIMING_LEVEL) return [];
  const windows: KaraokeTiming[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cells = selection[i] ?? [];
    const count = Math.min(cells.length, Math.max(1, Math.round((line.end_s - line.start_s) * level / FULL_TIMING_LEVEL)));
    windows.push(...cells.slice(0, count));
  }
  windows.sort((a, b) => a.start_s - b.start_s);
  const merged: KaraokeTiming[] = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window.start_s <= last.end_s) last.end_s = Math.max(last.end_s, window.end_s);
    else merged.push({ ...window });
  }
  return merged;
}
