import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import MicrophoneTuner from "./MicrophoneTuner";

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
afterEach(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function microphone(request: () => Promise<MediaStream>) {
  const close = vi.fn(() => Promise.resolve());
  const disconnect = vi.fn();
  const context = {
    state: "running", sampleRate: 48000, resume: () => Promise.resolve(), close,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect }),
    createAnalyser: () => ({ fftSize: 0, disconnect, getFloatTimeDomainData: vi.fn() }),
  };
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("AudioContext", vi.fn(() => context));
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: request } });
  return { close };
}

it("never requests the microphone until enabled and can cancel a pending permission", async () => {
  let resolve!: (stream: MediaStream) => void;
  const request = vi.fn(() => new Promise<MediaStream>(done => { resolve = done; }));
  const { close } = microphone(request);
  const stop = vi.fn();
  render(() => <MicrophoneTuner />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start microphone pitch detection" }));
  expect(screen.getByRole("button", { name: "Stop microphone pitch detection" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Stop microphone pitch detection" }));
  resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Start microphone pitch detection" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText("Microphone off")).toBeInTheDocument();
});

it("explains unavailable microphone support without requesting access", () => {
  const request = vi.fn();
  microphone(request);
  vi.stubGlobal("isSecureContext", false);
  render(() => <MicrophoneTuner />);
  fireEvent.click(screen.getByRole("button", { name: "Start microphone pitch detection" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/HTTPS and browser microphone support/);
  expect(request).not.toHaveBeenCalled();
});

it("reports permission denial and returns to off", async () => {
  const { close } = microphone(() => Promise.reject(new DOMException("Denied", "NotAllowedError")));
  render(() => <MicrophoneTuner />);
  fireEvent.click(screen.getByRole("button", { name: "Start microphone pitch detection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/permission was denied/i);
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Start microphone pitch detection" })).toHaveAttribute("aria-pressed", "false");
});

it("stops microphone tracks when the page becomes hidden", async () => {
  const track = { stop: vi.fn(), onended: null };
  const incoming = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const { close } = microphone(() => Promise.resolve(incoming));
  render(() => <MicrophoneTuner />);
  fireEvent.click(screen.getByRole("button", { name: "Start microphone pitch detection" }));
  await screen.findByText("Listening for a clear note…");
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  expect(track.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByText("Microphone off")).toBeInTheDocument();
});

it("stops a live microphone on unmount", async () => {
  const track = { stop: vi.fn(), onended: null };
  const incoming = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const { close } = microphone(() => Promise.resolve(incoming));
  const view = render(() => <MicrophoneTuner />);
  fireEvent.click(screen.getByRole("button", { name: "Start microphone pitch detection" }));
  await screen.findByText("Listening for a clear note…");
  view.unmount();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
