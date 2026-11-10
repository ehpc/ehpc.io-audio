export interface PianoVoice {
  release(at?: number): void;
  dispose(): void;
}
const ATTACK_SECONDS = 0.012;
const DECAY_SECONDS = 0.32;
const PEAK_GAIN = 0.065;
const SUSTAIN_GAIN = 0.024;
const RELEASE_SECONDS = 0.12;

// One output per instrument controls every voice without changing its envelope.
export function createPianoOutput(context: BaseAudioContext, volume: number): GainNode {
  const output = context.createGain();
  output.gain.value = volume;
  output.connect(context.destination);
  return output;
}

export function setPianoVolume(output: GainNode, volume: number, at = output.context.currentTime): void {
  if (output.context.state !== "running" && at === output.context.currentTime) {
    output.gain.cancelScheduledValues(at);
    output.gain.setValueAtTime(volume, at);
    return;
  }
  output.gain.cancelScheduledValues(at);
  output.gain.setTargetAtTime(volume, at, 0.005);
  output.gain.setValueAtTime(volume, at + 0.05);
}


// Harmonic oscillators and a decaying envelope give a piano-like (not sampled) tone.
// OfflineAudioContext is accepted so tests can render the actual instrument.
export function createPianoVoice(context: BaseAudioContext, midi: number, destination: AudioNode = context.destination, onEnd?: () => void): PianoVoice {
  const now = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + ATTACK_SECONDS);
  gain.gain.exponentialRampToValueAtTime(SUSTAIN_GAIN, now + DECAY_SECONDS);
  gain.connect(destination);
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const partials = [1, 2, 3].map((harmonic, index) => {
    const oscillator = context.createOscillator();
    const partial = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency * harmonic;
    partial.gain.value = [0.65, 0.23, 0.12][index];
    oscillator.connect(partial).connect(gain);
    oscillator.start(now);
    return { oscillator, partial };
  });
  let released = false;
  let disposed = false;
  let ended = 0;
  const disconnect = () => {
    if (disposed) return;
    disposed = true;
    for (const { oscillator, partial } of partials) {
      oscillator.disconnect();
      partial.disconnect();
    }
    gain.disconnect();
    onEnd?.();
  };
  for (const { oscillator } of partials) oscillator.onended = () => { if (++ended === partials.length) disconnect(); };
  return {
    release(at = context.currentTime) {
      if (released || disposed) return;
      released = true;
      const elapsed = Math.max(0, at - now);
      const level = elapsed < ATTACK_SECONDS
        ? PEAK_GAIN * elapsed / ATTACK_SECONDS
        : elapsed < DECAY_SECONDS
          ? PEAK_GAIN * (SUSTAIN_GAIN / PEAK_GAIN) ** ((elapsed - ATTACK_SECONDS) / (DECAY_SECONDS - ATTACK_SECONDS))
          : SUSTAIN_GAIN;
      gain.gain.cancelScheduledValues(at);
      if (elapsed > 0 && elapsed < ATTACK_SECONDS) gain.gain.linearRampToValueAtTime(level, at);
      else if (elapsed < DECAY_SECONDS && elapsed >= ATTACK_SECONDS) gain.gain.exponentialRampToValueAtTime(level, at);
      else gain.gain.setValueAtTime(level, at);
      gain.gain.linearRampToValueAtTime(0, at + RELEASE_SECONDS);
      for (const { oscillator } of partials) oscillator.stop(at + RELEASE_SECONDS + 0.01);
    },
    dispose() {
      if (disposed) return;
      if (!released) for (const { oscillator } of partials) oscillator.stop();
      disconnect();
    },
  };
}
