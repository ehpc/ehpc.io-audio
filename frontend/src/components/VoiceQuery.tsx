import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js";
import { Button } from "~/components/button";

// Web Speech is not included in TypeScript's DOM declarations. Keep the
// surface limited to dictation; audio never enters our upload/processing API.
export interface QueryRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionWindow = Window & {
  SpeechRecognition?: new () => QueryRecognition;
  webkitSpeechRecognition?: new () => QueryRecognition;
};

const VoiceQuery: Component<{
  resetToken: number;
  onStart: () => void;
  onTranscript: (text: string) => void;
}> = (props) => {
  const host = window as RecognitionWindow;
  const Recognition = host.SpeechRecognition ?? host.webkitSpeechRecognition;
  const [listening, setListening] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let active: QueryRecognition | null = null;
  const abort = () => {
    const previous = active;
    active = null;
    setListening(false);
    if (previous) {
      previous.onresult = previous.onerror = previous.onend = null;
      previous.abort();
    }
  };
  createEffect(() => {
    props.resetToken;
    abort();
    setError(null);
  });
  onCleanup(abort);
  const toggle = () => {
    if (active) {
      active.stop();
      return;
    }
    if (!Recognition) return;
    setError(null);
    props.onStart();
    const recognition = new Recognition();
    active = recognition;
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      if (active !== recognition) return;
      const text = Array.from(event.results, result => result[0]?.transcript ?? "").join(" ").trim();
      if (text) props.onTranscript(text);
    };
    recognition.onerror = (event) => {
      if (active !== recognition) return;
      const messages: Record<string, string> = {
        "not-allowed": "Microphone permission was denied. Allow microphone access or type your song.",
        "service-not-allowed": "Voice input is not allowed in this browser. Type your song instead.",
        "audio-capture": "No microphone is available. Connect one or type your song.",
        "network": "Voice input could not connect. Try again or type your song.",
        "no-speech": "No speech was heard. Try again or type your song.",
      };
      if (event.error !== "aborted") setError(messages[event.error] ?? "Voice input failed. Try again or type your song.");
      abort();
    };
    recognition.onend = () => {
      if (active !== recognition) return;
      active = null;
      setListening(false);
    };
    setListening(true);
    try {
      recognition.start();
    } catch {
      abort();
      setError("Voice input could not start. Use HTTPS and allow microphone access, or type your song.");
    }
  };
  return <Show when={Recognition}>
    <Button type="button" variant="outline" class="song-mic" aria-label={listening() ? "Stop voice input" : "Start voice input"}
      aria-pressed={listening()} onClick={toggle} title={listening() ? "Stop listening" : "Dictate a song search"}>
      <Show when={listening()} fallback={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
      }><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg></Show>
    </Button>
    <Show when={listening()}><p class="song-voice-status" role="status">Listening… Speak your song, then select Search.</p></Show>
    <Show when={error()}><p class="song-voice-status text-destructive" role="alert">{error()}</p></Show>
  </Show>;
};

export default VoiceQuery;
