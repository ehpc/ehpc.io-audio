import type { AlignedWordDTO, JobDTO, LyricPitchLineDTO } from "~/api";

export interface KaraokeTiming {
  start_s: number;
  end_s: number;
}

export interface KaraokeWord {
  text: string;
  timing: KaraokeTiming | null;
  /** Highlight timing provenance, independent of pitch-note associations. */
  timingOrigin?: "measured" | "estimated";
  /** Index in the separately published pitch word list, only when unambiguous. */
  pitchIndex?: number;
  /** Lexical token index within its presentation line. */
  tokenIndex?: number;
}

export type KaraokePart = string | KaraokeWord;

export interface KaraokeLine {
  text: string;
  parts: KaraokePart[];
  /** Output-clock bounds; null means there is no supported placement. */
  timing: KaraokeTiming | null;
  /** Provenance of a projected onset, not of the individual word timings. */
  onsetSource?: "provider-synced" | "acoustic" | "unknown";
  sourceKind?: "canonical" | "asr-extra" | "asr-word" | "segment" | "untimed";
  pitchAssociation?: LyricPitchLineDTO;
  projected?: boolean;
}

export interface KaraokeWordState {
  state: "untimed" | "pending" | "active" | "complete";
  progress: number;
}

// Same lexical boundaries as lyrics_reference.tokens; punctuation stays separate.
function lexicalMatches(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
}

function validTiming(start_s: number | null, end_s: number | null): KaraokeTiming | null {
  return start_s !== null && end_s !== null && Number.isFinite(start_s)
    && Number.isFinite(end_s) && start_s >= 0 && end_s > start_s
    ? { start_s, end_s } : null;
}

function wordTiming(word: AlignedWordDTO, rate: number): KaraokeTiming | null {
  return validTiming(word.start_s / rate, word.end_s / rate);
}


function makeLine(text: string, timings: Map<number, KaraokeTiming>): KaraokeLine {
  const parts: KaraokePart[] = [];
  let end = 0;
  lexicalMatches(text).forEach((match, index) => {
    const start = match.index!;
    if (start > end) parts.push(text.slice(end, start));
    const timing = timings.get(index) ?? null;
    parts.push({ text: match[0], timing, ...(timing ? { timingOrigin: "measured" as const } : {}), tokenIndex: index });
    end = start + match[0].length;
  });
  if (end < text.length) parts.push(text.slice(end));
  return { text, parts, timing: null };
}

/** Display-only estimates; never alter measured words or pitch associations. */
function estimateHighlights(line: KaraokeLine, safeEnd: number | undefined): void {
  const start = line.timing?.start_s;
  if (start === undefined || !Number.isFinite(start) || start < 0) return;
  const words = line.parts.filter((part): part is KaraokeWord => typeof part !== "string");
  const anchors = words.flatMap((word, index) => word.timing ? [index] : []);
  for (let i = 1; i < anchors.length; i++) {
    if (words[anchors[i - 1]].timing!.end_s > words[anchors[i]].timing!.start_s) return;
  }
  const limits = [-1, ...anchors, words.length];
  for (let i = 0; i + 1 < limits.length; i++) {
    const left = limits[i], right = limits[i + 1];
    if (right - left <= 1) continue;
    const lower = left < 0 ? start : words[left].timing!.end_s;
    const upper = right === words.length ? safeEnd : words[right].timing!.start_s;
    if (upper === undefined || !Number.isFinite(lower) || !Number.isFinite(upper)
      || lower < start || upper <= lower || (safeEnd !== undefined && upper > safeEnd)) continue;
    const missing = words.slice(left + 1, right);
    const weights = missing.map(word => Math.max(1, [...word.text.normalize("NFC")]
      .filter(character => /[\p{L}\p{N}]/u.test(character)).length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let offset = 0, previous = lower;
    missing.forEach((word, index) => {
      offset += weights[index];
      const end = index === missing.length - 1 ? upper : lower + (upper - lower) * offset / total;
      word.timing = { start_s: previous, end_s: end };
      word.timingOrigin = "estimated";
      previous = end;
    });
  }
}

/** Builds once per job, never once per animation frame. Does not infer syllables. */
export function karaokeLines(job: Pick<JobDTO, "transcript" | "pitch" | "options" | "lyric_pitch_lines">): KaraokeLine[] {
  const transcript = job.transcript;
  const rate = (job.pitch?.tempo_percent ?? job.options.tempo_percent) / 100;
  if (!Number.isFinite(rate) || rate <= 0) return [];
  if (transcript) {
    const lines: KaraokeLine[] = transcript.presentation_lines.map((line, lineIndex) => {
      const timings = new Map<number, KaraokeTiming>();
      for (const position of line.words) {
        const word = transcript.words?.[position.word_index];
        if (!word) continue;
        const timing = wordTiming(word, rate);
        if (timing) timings.set(position.token_index, timing);
      }
      const result = makeLine(line.text, timings);
      const onset = line.onset_s;
      if (onset !== null && Number.isFinite(onset) && onset >= 0) {
        const start_s = onset / rate;
        const end_s = line.end_s !== null && Number.isFinite(line.end_s) && line.end_s >= onset
          ? line.end_s / rate : start_s;
        result.timing = { start_s, end_s };
      }
      result.onsetSource = line.onset_source;
      result.sourceKind = line.source_kind;
      const association = job.lyric_pitch_lines?.[lineIndex];
      if (association && association.source_kind === line.source_kind && association.source_index === line.source_index
        && association.canonical_line_index === line.canonical_line_index) result.pitchAssociation = association;
      result.projected = true;
      return result;
    });
    let nextCanonical: KaraokeLine | undefined;
    let nextTimedCanonical: KaraokeLine | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.timing) {
        let end: number | undefined;
        let validOrder = true;
        if (line.sourceKind === "canonical") {
          // Display windows may skip untimed lines; estimates must not.
          const duration = job.pitch?.duration_s;
          const displayEnd = nextTimedCanonical?.timing?.start_s
            ?? (duration !== undefined && Number.isFinite(duration) ? duration : line.timing.start_s);
          line.timing.end_s = Math.max(line.timing.start_s, displayEnd);
          if (nextCanonical?.timing) {
            validOrder = nextCanonical.timing.start_s > line.timing.start_s;
            end = nextCanonical.timing.start_s;
          } else if (!nextCanonical && duration !== undefined && Number.isFinite(duration) && duration > line.timing.start_s) {
            end = duration;
          }
        } else if (line.timing.end_s > line.timing.start_s) {
          end = line.timing.end_s;
        }
        if (validOrder) estimateHighlights(line, end);
      }
      if (line.sourceKind === "canonical") {
        nextCanonical = line;
        if (line.timing) nextTimedCanonical = line;
      }
    }
    return lines;
  }

  // Historical pitch-only jobs have no phrase provenance.
  return (job.pitch?.words ?? []).flatMap((word, pitchIndex) => {
    const timing = wordTiming(word, 1);
    return timing ? [{
      text: word.text, parts: [{ text: word.text, timing, timingOrigin: "measured" as const, pitchIndex }], timing,
    }] : [];
  });
}

/** One-second preview, without hiding a preceding line while it is sung. */
export function currentKaraokeLine(lines: KaraokeLine[], position: number): KaraokeLine | null {
  let current: KaraokeLine | null = null;
  let previousEnd = 0;
  const extra = lines.find(line => (line.sourceKind === "asr-extra" || line.sourceKind === "asr-word") && line.timing
    && position >= line.timing.start_s && position < line.timing.end_s);
  if (extra) return extra;
  for (const line of lines) {
    if (!line.timing || line.sourceKind === "asr-extra" || line.sourceKind === "asr-word") continue;
    const enter = Math.max(0, line.timing.start_s - 1, previousEnd);
    if (position < enter) break;
    current = line;
    previousEnd = line.timing.end_s;
  }
  return current;
}

export function karaokeWordState(timing: KaraokeTiming | null, position: number): KaraokeWordState {
  if (!timing) return { state: "untimed", progress: 0 };
  if (position < timing.start_s) return { state: "pending", progress: 0 };
  if (position >= timing.end_s) return { state: "complete", progress: 1 };
  return { state: "active", progress: (position - timing.start_s) / (timing.end_s - timing.start_s) };
}
