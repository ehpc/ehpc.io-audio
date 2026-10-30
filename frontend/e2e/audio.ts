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

interface MixTransform {
  pitchSemitones: number;
  tempoPercent: number;
  referencePath: string;
}

export function inspectMix(mixPath: string, vocalPath: string, instrumentPath: string, transform?: MixTransform) {
  const mix = pcm(mixPath);
  let expected: Float32Array;
  let instrument: Float32Array | undefined;
  if (transform) {
    const summed = `${transform.referencePath}-sum.mp3`;
    const decoded = `${transform.referencePath}-decoded.wav`;
    const adjusted = `${transform.referencePath}-adjusted.wav`;
    // Build the oracle from untransformed real prerequisites: summing separately
    // transformed stems would incorrectly assume Rubber Band is linear.
    execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-y', '-i', vocalPath, '-i', instrumentPath,
      '-filter_complex',
      '[0:a:0]aresample=48000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[v];' +
      '[1:a:0]aresample=48000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[i];' +
      '[v][i]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,' +
      'alimiter=limit=0.89:attack=5:release=50:level=false:latency=true[out]',
      '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '0', summed,
    ]);
    execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-y', '-i', summed,
      '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', decoded,
    ]);
    execFileSync('rubberband', [
      '--fine', '--formant', '--pitch', String(transform.pitchSemitones),
      '--tempo', `100:${transform.tempoPercent}`, decoded, adjusted,
    ]);
    execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-y', '-i', adjusted,
      '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '0', transform.referencePath,
    ]);
    expected = pcm(transform.referencePath);
  } else {
    expected = pcm(vocalPath);
    instrument = pcm(instrumentPath);
  }
  const expectedLength = Math.max(expected.length, instrument?.length ?? 0);
  expect(Math.abs(mix.length - expectedLength) / 96000, 'mix must retain the full sum duration').toBeLessThan(0.20);
  const count = Math.min(mix.length, expectedLength);
  let dot = 0, sourceEnergy = 0, mixEnergy = 0, error = 0;
  // Ignore MP3 codec boundary padding, compare actual simultaneous waveforms.
  for (let i = 4800; i < count - 4800; i++) {
    const sample = (expected[i] ?? 0) + (instrument?.[i] ?? 0);
    dot += mix[i] * sample;
    sourceEnergy += sample ** 2;
    mixEnergy += mix[i] ** 2;
    error += (mix[i] - sample) ** 2;
  }
  const correlation = dot / Math.sqrt(sourceEnergy * mixEnergy);
  const relativeError = Math.sqrt(error / sourceEnergy);
  expect(correlation, `mix must be an aligned sum: ${mixPath}`).toBeGreaterThan(0.97);
  expect(relativeError, `mix must retain unity gain: ${mixPath}`).toBeLessThan(0.20);
  return { correlation, relativeError, comparedSamples: count, transform };
}

/** Compare the full-song output to one independent combined render of the source. */
export function inspectTransformedSource(outputPath: string, sourcePath: string, pitch: number, tempo: number, referencePath: string) {
  const decoded = `${referencePath}-decoded.wav`;
  const adjusted = `${referencePath}-adjusted.wav`;
  execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-y', '-i', sourcePath,
    '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', decoded,
  ]);
  execFileSync('rubberband', [
    '--fine', '--formant', '--pitch', String(pitch),
    '--tempo', `100:${tempo}`, decoded, adjusted,
  ]);
  execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-y', '-i', adjusted,
    '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '0', referencePath,
  ]);
  const expected = pcm(referencePath);
  const actual = pcm(outputPath);
  expect(actual.length, 'full song must retain the complete transformed source').toBe(expected.length);
  let error = 0, energy = 0;
  for (let index = 0; index < expected.length; index++) {
    error += (actual[index] - expected[index]) ** 2;
    energy += expected[index] ** 2;
  }
  const relativeError = Math.sqrt(error / energy);
  expect(relativeError, 'full song must be the transformed original, not a reconstructed stem mix').toBeLessThan(0.02);
  return { relativeError, comparedSamples: expected.length, referencePath };
}
