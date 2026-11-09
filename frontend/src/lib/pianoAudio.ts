export interface PianoVoice {
  release(at?: number): void;
  dispose(): void;
}

// Harmonic oscillators and a decaying envelope give a piano-like (not sampled) tone.
// OfflineAudioContext is accepted so tests can render the actual instrument.
export function createPianoVoice(context: BaseAudioContext, midi: number, destination: AudioNode = context.destination, onEnd?: () => void): PianoVoice {
  const now = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.065, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.024, now + 0.32);
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
      gain.gain.cancelAndHoldAtTime(at);
      gain.gain.linearRampToValueAtTime(0, at + 0.12);
      for (const { oscillator } of partials) oscillator.stop(at + 0.13);
    },
    dispose() {
      if (disposed) return;
      if (!released) for (const { oscillator } of partials) oscillator.stop();
      disconnect();
    },
  };
}
