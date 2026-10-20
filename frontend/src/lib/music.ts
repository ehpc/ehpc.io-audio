const NOTES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const NATURAL_PITCHES = [0, 2, 4, 5, 7, 9, 11];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const NATURAL_MINOR = [0, 2, 3, 5, 7, 8, 10];

interface ParsedKey {
  letter: number;
  pitch: number;
  minor: boolean;
}

export interface KeyScale {
  mode: "major" | "natural minor";
  notes: string[];
}

function parseKey(key: string | null): ParsedKey | null {
  const match = key?.match(/^([A-G])([b#]?) (major|minor)(?: \([+-][\d.]+ cents\))?$/);
  if (!match) return null;
  const letter = LETTERS.indexOf(match[1]);
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  return { letter, pitch: (NATURAL_PITCHES[letter] + accidental + 12) % 12, minor: match[3] === "minor" };
}

export function keyScale(key: string | null): KeyScale | null {
  const parsed = parseKey(key);
  if (!parsed) return null;
  const intervals = parsed.minor ? NATURAL_MINOR : MAJOR;
  return {
    mode: parsed.minor ? "natural minor" : "major",
    notes: intervals.map((interval, index) => {
      const letter = (parsed.letter + index) % 7;
      let accidental = (parsed.pitch + interval - NATURAL_PITCHES[letter] + 12) % 12;
      if (accidental > 6) accidental -= 12;
      return LETTERS[letter] + (accidental < 0 ? "b".repeat(-accidental) : "#".repeat(accidental));
    }),
  };
}

interface PitchParts {
  semitones: bigint;
  cents: string | null;
}

function pitchParts(pitch: number): PitchParts {
  const [coefficient, exponent = "0"] = Math.abs(pitch).toString().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const scale = fraction.length - Number(exponent);
  let numerator = BigInt(whole + fraction);
  if (scale <= 0) {
    return { semitones: BigInt(Math.sign(pitch)) * numerator * 10n ** BigInt(-scale), cents: null };
  }
  const denominator = 10n ** BigInt(scale);
  let semitones = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) semitones += 1n;
  const sign = BigInt(Math.sign(pitch));
  numerator *= sign;
  semitones *= sign;
  const residual = (numerator - semitones * denominator) * 100n;
  if (residual === 0n) return { semitones, cents: null };
  const digits = (residual < 0n ? -residual : residual).toString().padStart(scale + 1, "0");
  const cents = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  return { semitones, cents: `${residual > 0n ? "+" : "-"}${cents}` };
}

export function transposeKey(original: string | null, pitch: number): string | null {
  const key = parseKey(original);
  if (!key || !Number.isFinite(pitch)) return null;
  // Exact decimal arithmetic matches the backend's ROUND_HALF_UP and cents.
  const { semitones, cents } = pitchParts(pitch);
  const noteIndex = Number(((BigInt(key.pitch) + semitones) % 12n + 12n) % 12n);
  let output = `${NOTES[noteIndex]} ${key.minor ? "minor" : "major"}`;
  if (cents !== null) output += ` (${cents} cents)`;
  return output;
}
