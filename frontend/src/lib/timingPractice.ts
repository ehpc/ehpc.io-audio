import type { JobDTO } from "~/api";
import { karaokeLines, type KaraokeTiming } from "./karaoke";

export type TimingHintLevel = 0 | 1 | 2 | 3 | 4;
export type TimingCenters = readonly (readonly number[])[];
export const TIMING_HINT_LABELS = ["Vocals off", "0.5s snippets", "1s snippets", "2s snippets", "Full vocals"] as const;
const DURATIONS = [0, 0.5, 1, 2] as const;

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

/** Three independent stratified centers per line; created once per practice session. */
export function timingCenters(lines: readonly KaraokeTiming[], random: () => number = Math.random): TimingCenters {
  return lines.map(line => Array.from({ length: 3 }, (_, index) => {
    const sample = Math.max(0, Math.min(1, random()));
    return line.start_s + (line.end_s - line.start_s) * (index + 0.2 + sample * 0.6) / 3;
  }));
}

export function timingWindows(lines: readonly KaraokeTiming[], centers: TimingCenters, level: TimingHintLevel): KaraokeTiming[] {
  if (level === 0 || level === 4) return [];
  const duration = DURATIONS[level];
  const windows: KaraokeTiming[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!Number.isFinite(line.start_s) || !Number.isFinite(line.end_s) || line.end_s <= line.start_s) continue;
    for (const center of centers[i] ?? []) {
      if (!Number.isFinite(center)) continue;
      const length = Math.min(duration, line.end_s - line.start_s);
      const start_s = Math.max(line.start_s, Math.min(center - length / 2, line.end_s - length));
      const end_s = start_s + length;
      if (end_s > start_s) windows.push({ start_s, end_s });
    }
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
