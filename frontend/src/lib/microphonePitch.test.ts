import { expect, it } from "vitest";
import { createMicrophonePitchDetector, frequencyToPitch, MICROPHONE_WINDOW_SIZE } from "./microphonePitch";

function tone(hz: number, sampleRate: number, amplitude = 0.2) {
  return Float32Array.from({ length: MICROPHONE_WINDOW_SIZE }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / sampleRate));
}

it("maps chromatic pitch and signed cents without clamping the actual reading", () => {
  expect(frequencyToPitch(440)).toEqual({ midi: 69, cents: 0 });
  expect(frequencyToPitch(440 * 2 ** (30 / 1200))).toEqual({ midi: 69, cents: 30 });
  expect(frequencyToPitch(440 * 2 ** (-30 / 1200))).toEqual({ midi: 69, cents: -30 });
  expect(frequencyToPitch(0)).toBeNull();
  expect(frequencyToPitch(NaN)).toBeNull();
});

it.each([44100, 48000])("detects voiced notes and detuning at the device sample rate %i", sampleRate => {
  const detect = createMicrophonePitchDetector();
  expect(detect(tone(329.6275569, sampleRate), sampleRate)).toEqual({ midi: 64, cents: 0 });
  const sharp = detect(tone(440 * 2 ** (18 / 1200), sampleRate), sampleRate);
  expect(sharp?.midi).toBe(69);
  expect(sharp!.cents).toBeGreaterThanOrEqual(17);
  expect(sharp!.cents).toBeLessThanOrEqual(19);
  const flat = detect(tone(220 * 2 ** (-30 / 1200), sampleRate), sampleRate);
  expect(flat?.midi).toBe(57);
  expect(flat!.cents).toBeGreaterThanOrEqual(-31);
  expect(flat!.cents).toBeLessThanOrEqual(-29);
});

it("does not invent a centered note for silence, quiet audio or broadband noise", () => {
  const detect = createMicrophonePitchDetector();
  const rate = 48000;
  let seed = 12345;
  const noise = Float32Array.from({ length: MICROPHONE_WINDOW_SIZE }, () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return (seed / 0xffffffff * 2 - 1) * 0.15;
  });
  expect(detect(new Float32Array(MICROPHONE_WINDOW_SIZE), rate)).toBeNull();
  expect(detect(tone(440, rate, 0.001), rate)).toBeNull();
  expect(detect(noise, rate)).toBeNull();
});
