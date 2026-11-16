import { PitchDetector } from "pitchy";

export const MICROPHONE_WINDOW_SIZE = 4096;
const MINIMUM_RMS = 0.01;
const MINIMUM_CLARITY = 0.9;

export interface MicrophonePitch {
  midi: number;
  cents: number;
}

export function frequencyToPitch(frequency: number): MicrophonePitch | null {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  const exact = 69 + 12 * Math.log2(frequency / 440);
  const midi = Math.round(exact);
  if (midi < 0 || midi > 127) return null;
  return { midi, cents: Math.round((exact - midi) * 100) || 0 };
}

// Pitchy retains its FFT/autocorrelation buffers across analyses.
export function createMicrophonePitchDetector() {
  const detector = PitchDetector.forFloat32Array(MICROPHONE_WINDOW_SIZE);
  detector.minVolumeAbsolute = MINIMUM_RMS;
  return (samples: Float32Array, sampleRate: number): MicrophonePitch | null => {
    const [frequency, clarity] = detector.findPitch(samples, sampleRate);
    return clarity >= MINIMUM_CLARITY ? frequencyToPitch(frequency) : null;
  };
}
