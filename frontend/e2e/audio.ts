import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';

export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function pcm(path: string): Float32Array {
  const bytes = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', '48000', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export async function inspectAudio(page: Page, path: string, expectedDuration: number, expectedFundamental?: number) {
  const bytes = await readFile(path);
  const decoded = await page.evaluate(async data => {
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(new Uint8Array(data).buffer);
      return { duration: audio.duration, channels: audio.numberOfChannels, sampleRate: audio.sampleRate };
    } finally { await context.close(); }
  }, [...bytes]);
  expect(decoded.channels).toBe(2);
  expect(Math.abs(decoded.duration - expectedDuration)).toBeLessThan(0.20);
  const samples = pcm(path);
  let sum = 0, peak = 0, finite = true;
  const quarters = [0, 0, 0, 0];
  for (let i = 0; i < samples.length; i++) {
    finite &&= Number.isFinite(samples[i]);
    sum += samples[i] ** 2;
    peak = Math.max(peak, Math.abs(samples[i]));
    quarters[Math.min(3, Math.floor(i * 4 / samples.length))] += samples[i] ** 2;
  }
  expect(finite, 'decoded samples must all be finite').toBe(true);
  const rms = Math.sqrt(sum / samples.length);
  expect(rms, `decoded audio must contain real signal: ${path}`).toBeGreaterThan(1e-7);
  expect(peak).toBeLessThanOrEqual(1.05);
  expect(Math.abs(samples.length / 96000 - expectedDuration)).toBeLessThan(0.20);
  let fundamental: number | undefined;
  if (expectedFundamental !== undefined) {
    const start = Math.floor(0.18 * 48000);
    const end = Math.floor(Math.min(0.72, expectedDuration / 9) * 48000);
    const windowed = new Float64Array(end - start);
    for (let i = start; i < end; i++) {
      const mono = (samples[i * 2] + samples[i * 2 + 1]) / 2;
      windowed[i - start] = mono * (0.5 - 0.5 * Math.cos(2 * Math.PI * (i - start) / (end - start)));
    }
    const powerAt = (frequency: number) => {
      const coefficient = 2 * Math.cos(2 * Math.PI * frequency / 48000);
      let previous = 0, older = 0;
      for (const sample of windowed) {
        const current = sample + coefficient * previous - older;
        older = previous;
        previous = current;
      }
      return older ** 2 + previous ** 2 - coefficient * previous * older;
    };
    // Locate the actual dominant component independently of the expected shift.
    // An unshifted file must not pass by selecting a sidelobe near the target.
    let strongest = -Infinity;
    for (let frequency = 100; frequency <= 600; frequency++) {
      const power = powerAt(frequency);
      if (power > strongest) { strongest = power; fundamental = frequency; }
    }
    const coarse = fundamental!;
    for (let frequency = coarse - 1; frequency <= coarse + 1; frequency += 0.05) {
      const power = powerAt(frequency);
      if (power > strongest) { strongest = power; fundamental = frequency; }
    }
    expect(Math.abs(fundamental! - expectedFundamental)).toBeLessThan(1.5);
  }
  return { ...decoded, sha256: hash(bytes), size: bytes.length, rms, peak, quarterRms: quarters.map(value => Math.sqrt(value / (samples.length / 4))), fundamental };
}

export function inspectMix(mixPath: string, vocalPath: string, instrumentPath: string) {
  const mix = pcm(mixPath), vocal = pcm(vocalPath), instrument = pcm(instrumentPath);
  const count = Math.min(mix.length, vocal.length, instrument.length);
  let dot = 0, sourceEnergy = 0, mixEnergy = 0, error = 0;
  // Ignore MP3 codec boundary padding, compare actual simultaneous waveforms.
  for (let i = 4800; i < count - 4800; i++) {
    const expected = vocal[i] + instrument[i];
    dot += mix[i] * expected;
    sourceEnergy += expected ** 2;
    mixEnergy += mix[i] ** 2;
    error += (mix[i] - expected) ** 2;
  }
  const correlation = dot / Math.sqrt(sourceEnergy * mixEnergy);
  const relativeError = Math.sqrt(error / sourceEnergy);
  expect(correlation, `mix must be an aligned sum: ${mixPath}`).toBeGreaterThan(0.97);
  expect(relativeError, `mix must retain unity gain: ${mixPath}`).toBeLessThan(0.20);
  return { correlation, relativeError, comparedSamples: count };
}
