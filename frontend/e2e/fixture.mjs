import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function stereoWav(rate, seconds) {
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 4, 40);
  return wav;
}

export function silentFixture() {
  return stereoWav(44100, 8);
}

export function tonalFixture() {
  // Unlike the changing chords/voices below, a sustained C/E/G triad is an
  // unambiguous known-key reference. C4 dominates for independent pitch checks.
  const rate = 44100;
  const seconds = 8;
  const wav = stereoWav(rate, seconds);
  for (let i = 0; i < rate * seconds; i++) {
    const t = i / rate;
    const fade = Math.min(1, t / 0.03, (seconds - t) / 0.05);
    const sample = fade * (
      0.20 * Math.sin(2 * Math.PI * 261.6256 * t) +
      0.08 * Math.sin(2 * Math.PI * 329.6276 * t) +
      0.08 * Math.sin(2 * Math.PI * 391.9954 * t)
    );
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(sample * 32767), 46 + i * 4);
  }
  return wav;
}

// Original deterministic synthesis, not a recording or an adaptation of a song.
// Four harmony bars, bass, panned chords, a harmonic vowel-like lead,
// a quieter backing voice and seeded percussion exercise real audio models.
export function musicalFixture(seed) {
  const rate = 44100;
  const seconds = 8;
  const samples = rate * seconds;
  const wav = stereoWav(rate, seconds);
  const chords = [[130.8128, 164.8138, 195.9977], [174.6141, 220, 261.6256], [195.9977, 246.9417, 293.6648], [130.8128, 164.8138, 195.9977]];
  const melody = [261.6256, 329.6276, 391.9954, 329.6276, 349.2282, 440, 391.9954, 261.6256];
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const bar = Math.floor(t / 2);
    const beat = t % 0.5;
    const note = Math.floor(t);
    const envelope = Math.min(1, (t % 1) / 0.06) * Math.min(1, (1 - t % 1) / 0.10);
    const fade = Math.min(1, t / 0.03, (seconds - t) / 0.05);
    // The first note has a strong known C4 fundamental for pitch proof.
    const frequency = melody[note];
    let voice = 0;
    for (let harmonic = 1; harmonic <= 12; harmonic++) {
      const formant = 0.8 * Math.exp(-(((harmonic * frequency - 700) / 350) ** 2)) + 0.3 * Math.exp(-(((harmonic * frequency - 1200) / 500) ** 2));
      voice += (harmonic === 1 ? 0.16 : 0.075 * formant / harmonic) * Math.sin(2 * Math.PI * harmonic * frequency * t + 0.025 * Math.sin(2 * Math.PI * 5 * t));
    }
    voice *= envelope;
    const backing = 0.035 * Math.sin(2 * Math.PI * frequency * 0.5 * t) * envelope;
    const chord = chords[bar].map(f => 0.024 * Math.sin(2 * Math.PI * f * t));
    const bass = 0.055 * Math.sin(2 * Math.PI * chords[bar][0] * 0.5 * t);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    const kick = 0.12 * Math.exp(-beat * 32) * Math.sin(2 * Math.PI * (55 * beat + 2 * (1 - Math.exp(-beat * 30))));
    const snare = Math.floor(t / 0.5) % 2 ? 0.035 * noise * Math.exp(-beat * 45) : 0;
    const hat = 0.009 * noise * Math.exp(-(t % 0.25) * 120);
    const left = fade * (voice + backing + bass + kick + snare + hat + chord[0] + chord[1] * 0.6 + chord[2] * 0.3);
    const right = fade * (voice + backing * 0.8 + bass + kick + snare + hat + chord[0] * 0.3 + chord[1] * 0.6 + chord[2]);
    wav.writeInt16LE(Math.round(left * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(right * 32767), 46 + i * 4);
  }
  return wav;
}

// CC-BY-4.0 LibriSpeech recordings, supplied by librosa/data; full attribution
// and modification notice are in README's full-stack fixture section.
export async function vocalFixture(seed) {
  const sources = [
    ['5703-47212-0000.ogg', 'a284612b46af0535f7e1873758c4387bb8369f6dbbe192ffdec1f171108f98dd'],
    ['198-209-0000.ogg', '0473ba9613befa1026db5e254546f105aeffba8366b5468fc5e8d474d844ca1d'],
  ];
  const voices = [];
  for (const [name, sha256] of sources) {
    const url = `https://raw.githubusercontent.com/librosa/data/38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0/audio/${name}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Licensed fixture download failed: ${response.status} ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`Fixture checksum mismatch: ${url}`);
    const decoded = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', 'pipe:0', '-t', '8', '-f', 'f32le', '-ac', '1', '-ar', '44100', 'pipe:1'], { input: bytes, maxBuffer: 8 * 1024 * 1024 });
    const samples = new Float32Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength));
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    voices.push(samples.map(sample => sample / peak));
  }
  const wav = musicalFixture(seed);
  for (let i = 0; i < 44100 * 8; i++) {
    const lead = (voices[0][i] ?? 0) * 0.27;
    const female = (voices[1][i] ?? 0) * 0.25;
    const backing = (voices[1][i - 11025] ?? 0) * 0.10;
    const fade = Math.min(1, i / 2205, (44100 * 8 - i) / 2205);
    const left = wav.readInt16LE(44 + i * 4) / 32767 + fade * (lead + female * 0.75 + backing);
    const right = wav.readInt16LE(46 + i * 4) / 32767 + fade * (lead + female + backing * 0.4);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left)) * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right)) * 32767), 46 + i * 4);
  }
  return wav;
}
