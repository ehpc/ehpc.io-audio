import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VoiceQuery, { type QueryRecognition } from "./VoiceQuery";

class Recognition implements QueryRecognition {
  static instances: Recognition[] = [];
  lang = "";
  continuous = true;
  interimResults = true;
  onresult: QueryRecognition["onresult"] = null;
  onerror: QueryRecognition["onerror"] = null;
  onend: QueryRecognition["onend"] = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() { Recognition.instances.push(this); }
}
const start = () => {
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  return Recognition.instances.at(-1)!;
};

beforeEach(() => { Recognition.instances = []; });
afterEach(() => vi.unstubAllGlobals());

describe("voice query dictation", () => {
  it("hides the mic when neither browser API exists", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    render(() => <VoiceQuery resetToken={0} onStart={vi.fn()} onTranscript={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each(["SpeechRecognition", "webkitSpeechRecognition"])("uses %s only after a click and stops normally", (api) => {
    vi.stubGlobal(api, Recognition);
    const transcript = vi.fn();
    const onStart = vi.fn();
    render(() => <VoiceQuery resetToken={0} onStart={onStart} onTranscript={transcript} />);
    expect(Recognition.instances).toHaveLength(0);
    const recognition = start();
    expect(recognition.start).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
    expect(recognition.continuous).toBe(false);
    expect(recognition.interimResults).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    expect(recognition.stop).toHaveBeenCalledOnce();
    recognition.onresult?.({ results: [[{ transcript: "  宇多田ヒカル First Love  " }]] });
    expect(transcript).toHaveBeenCalledWith("宇多田ヒカル First Love");
    recognition.onend?.();
    expect(screen.getByRole("button", { name: "Start voice input" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([
    ["not-allowed", "Microphone permission was denied"],
    ["network", "Voice input could not connect"],
    ["no-speech", "No speech was heard"],
  ])("restores a retryable button after %s", (error, message) => {
    vi.stubGlobal("SpeechRecognition", Recognition);
    render(() => <VoiceQuery resetToken={0} onStart={vi.fn()} onTranscript={vi.fn()} />);
    const recognition = start();
    recognition.onerror?.({ error });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(recognition.abort).toHaveBeenCalledOnce();
    start();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop voice input" })).toBeInTheDocument();
  });

  it("aborts on an edited query and unmount, rejecting callbacks saved by the browser", () => {
    vi.stubGlobal("SpeechRecognition", Recognition);
    const transcript = vi.fn();
    const [revision, setRevision] = createSignal(0);
    const view = render(() => <VoiceQuery resetToken={revision()} onStart={vi.fn()} onTranscript={transcript} />);
    const first = start();
    const lateResult = first.onresult;
    const lateError = first.onerror;
    const lateEnd = first.onend;
    setRevision(1);
    expect(first.abort).toHaveBeenCalledOnce();
    const second = start();
    lateResult?.({ results: [[{ transcript: "obsolete song" }]] });
    lateError?.({ error: "not-allowed" });
    lateEnd?.();
    expect(transcript).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop voice input" })).toBeInTheDocument();
    const afterUnmount = second.onresult;
    view.unmount();
    expect(second.abort).toHaveBeenCalledOnce();
    afterUnmount?.({ results: [[{ transcript: "too late" }]] });
    expect(transcript).not.toHaveBeenCalled();
  });
});
