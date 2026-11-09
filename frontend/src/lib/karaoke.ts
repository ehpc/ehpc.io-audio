import type { AlignedWordDTO, JobDTO } from "~/api";

export interface KaraokeTiming {
  start_s: number;
  end_s: number;
}

export interface KaraokeWord {
  text: string;
  timing: KaraokeTiming | null;
  /** Index in the separately published pitch word list, only when unambiguous. */
  pitchIndex?: number;
}

export type KaraokePart = string | KaraokeWord;

export interface KaraokeLine {
  text: string;
  parts: KaraokePart[];
  /** Output-clock bounds; null means there is no supported placement. */
  timing: KaraokeTiming | null;
}

export interface KaraokeWordState {
  state: "untimed" | "pending" | "active" | "complete";
  progress: number;
}

// Same lexical boundaries as lyrics_reference.tokens: punctuation is preserved
// separately, and only published word timings can animate a lexical token.
function lexicalMatches(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().replaceAll("’", "'");
}

function validTiming(start_s: number | null, end_s: number | null): KaraokeTiming | null {
  return start_s !== null && end_s !== null && Number.isFinite(start_s)
    && Number.isFinite(end_s) && start_s >= 0 && end_s > start_s
    ? { start_s, end_s } : null;
}

function wordTiming(word: AlignedWordDTO, rate: number): KaraokeTiming | null {
  return validTiming(word.start_s / rate, word.end_s / rate);
}

interface WordPlacement {
  timing: KaraokeTiming;
  pitchIndex?: number;
}

function wordKey(word: AlignedWordDTO, timing: KaraokeTiming): string {
  return JSON.stringify([word.text, timing.start_s, timing.end_s, word.origin ?? null]);
}

function makeLine(text: string, timings: Map<number, WordPlacement>, bounds: KaraokeTiming | null): KaraokeLine {
  const parts: KaraokePart[] = [];
  let end = 0;
  lexicalMatches(text).forEach((match, index) => {
    const start = match.index!;
    if (start > end) parts.push(text.slice(end, start));
    const placement = timings.get(index);
    parts.push({ text: match[0], timing: placement?.timing ?? null, ...(placement?.pitchIndex === undefined ? {} : { pitchIndex: placement.pitchIndex }) });
    end = start + match[0].length;
  });
  if (end < text.length) parts.push(text.slice(end));
  const known = [...timings.values()].map(placement => placement.timing);
  const extent = known.length ? {
    start_s: Math.min(...known.map(timing => timing.start_s)),
    end_s: Math.max(...known.map(timing => timing.end_s)),
  } : null;
  // Independently supported phrase bounds include untimed leading/trailing
  // lyrics. Preserve them only when they contain all published word timings;
  // contradictory bounds must not truncate or relocate the known sung words.
  const timing = bounds && (!extent
    || (bounds.start_s <= extent.start_s && bounds.end_s >= extent.end_s))
    ? bounds : extent;
  return {
    text, parts, timing,
  };
}

/** Builds once per job, never once per animation frame. Does not infer syllables. */
export function karaokeLines(job: Pick<JobDTO, "transcript" | "pitch" | "options">): KaraokeLine[] {
  const transcript = job.transcript;
  const rate = (job.pitch?.tempo_percent ?? job.options.tempo_percent) / 100;
  if (!Number.isFinite(rate) || rate <= 0) return [];
  // Pitch words are a filtered output-clock projection, not transcript indices.
  // Require a unique full identity on both sides; duplicates remain unlinked.
  const pitchIndices = new Map<string, number | null>();
  (job.pitch?.words ?? []).forEach((word, index) => {
    const timing = wordTiming(word, 1);
    if (!timing) return;
    const key = wordKey(word, timing);
    pitchIndices.set(key, pitchIndices.has(key) ? null : index);
  });
  const transcriptCounts = new Map<string, number>();
  for (const word of transcript?.words ?? []) {
    const timing = wordTiming(word, rate);
    if (!timing) continue;
    const key = wordKey(word, timing);
    transcriptCounts.set(key, (transcriptCounts.get(key) ?? 0) + 1);
  }
  const placement = (word: AlignedWordDTO, timing: KaraokeTiming): WordPlacement => {
    const key = wordKey(word, timing);
    const pitchIndex = transcriptCounts.get(key) === 1 ? pitchIndices.get(key) : undefined;
    return pitchIndex === null || pitchIndex === undefined ? { timing } : { timing, pitchIndex };
  };
  const canonical = transcript?.reference?.lines;
  if (canonical?.length) {
    const timings = canonical.map(() => new Map<number, WordPlacement>());
    for (const position of transcript?.canonical_word_positions ?? []) {
      const line = canonical[position.reference_line_index];
      const word = transcript?.words?.[position.word_index];
      if (!line || line.status !== "aligned" || !word) continue;
      // These indices are provenance into transcript.words, not a text search
      // or an index into the separately filtered output-clock pitch words.
      const timing = wordTiming(word, rate);
      if (timing) timings[position.reference_line_index].set(position.reference_token_index, placement(word, timing));
    }
    const lines = canonical.map((line, index) => makeLine(
      line.text, timings[index],
      line.status === "aligned" && line.start_s !== null && line.end_s !== null
        ? validTiming(line.start_s / rate, line.end_s / rate) : null,
    ));
    // Reference assembly also publishes accepted ASR extras in transcript.words.
    // Canonical priority is local to supported intervals, not the entire song:
    // never hold an old verse over a known sung word in an untimed reference gap.
    const extras: KaraokeLine[] = (transcript?.words ?? []).flatMap(word => {
      const timing = wordTiming(word, rate);
      if (!timing || lines.some(line => line.timing
        && timing.start_s < line.timing.end_s && timing.end_s > line.timing.start_s)) return [];
      return [{ text: word.text, parts: [{ text: word.text, ...placement(word, timing) }], timing }];
    });
    return [...lines, ...extras].sort((a, b) =>
      (a.timing?.start_s ?? Infinity) - (b.timing?.start_s ?? Infinity));
  }

  const words = transcript?.words?.length
    ? transcript.words.map(word => {
      const timing = wordTiming(word, rate);
      return { word, timing, pitchIndex: timing ? placement(word, timing).pitchIndex : undefined };
    })
    : (job.pitch?.words ?? []).map((word, pitchIndex) => ({ word, timing: wordTiming(word, 1), pitchIndex }));
  if (transcript?.segments.length) {
    return transcript.segments.map(segment => {
      const bounds = validTiming(segment.start_s / rate, segment.end_s / rate);
      const heard = bounds ? words.filter(({ timing }) => timing
        && timing.start_s >= bounds.start_s - 0.001 && timing.end_s <= bounds.end_s + 0.001) : [];
      const tokens = lexicalMatches(segment.text).map(match => normalized(match[0]));
      const heardTokens = heard.map(({ word }) => {
        const matches = lexicalMatches(word.text);
        return matches.length === 1 ? normalized(matches[0][0]) : null;
      });
      const exact = tokens.length === heardTokens.length && tokens.every((token, i) => token === heardTokens[i]);
      const timings = new Map<number, WordPlacement>();
      tokens.forEach((token, tokenIndex) => {
        // Complete ordered sequences are safe even with repeats. With a partial
        // alignment, repeated tokens stay unknown rather than guessing a slot.
        const heardIndex = exact ? tokenIndex : heardTokens.indexOf(token);
        if (heardIndex < 0 || (!exact && (tokens.indexOf(token) !== tokens.lastIndexOf(token)
          || heardTokens.indexOf(token) !== heardTokens.lastIndexOf(token)))) return;
        const item = heard[heardIndex];
        if (item.timing) timings.set(tokenIndex, { timing: item.timing, ...(item.pitchIndex === undefined ? {} : { pitchIndex: item.pitchIndex }) });
      });
      return makeLine(segment.text, timings, bounds);
    });
  }

  // Historical pitch-only jobs have no phrase provenance: show the actual
  // timed word, not an invented sentence assembled across a verse boundary.
  return words.flatMap(({ word, timing, pitchIndex }) => timing ? [{
    text: word.text,
    parts: [{ text: word.text, timing, ...(pitchIndex === undefined ? {} : { pitchIndex }) }], timing,
  }] : []);
}

/** One-second preview, without hiding a preceding line while it is sung. */
export function currentKaraokeLine(lines: KaraokeLine[], position: number): KaraokeLine | null {
  let current: KaraokeLine | null = null;
  let previousEnd = 0;
  for (const line of lines) {
    if (!line.timing) continue;
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
