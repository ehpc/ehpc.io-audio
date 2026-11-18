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

function microphone(request: (constraints: MediaStreamConstraints) => Promise<MediaStream>, devices?: MediaDeviceInfo[]) {
  const close = vi.fn(() => Promise.resolve());
  const disconnect = vi.fn();
  const analyser = { fftSize: 0, disconnect, getFloatTimeDomainData: vi.fn<(samples: Float32Array) => void>() };
  const context = {
    state: "running", sampleRate: 48000, resume: () => Promise.resolve(), close,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect }),
    createAnalyser: () => analyser,
  };
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("AudioContext", vi.fn(() => context));
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const mediaDevices = Object.assign(new EventTarget(), { getUserMedia: request, enumerateDevices: vi.fn(async () => devices ?? []) });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
  return { close, mediaDevices, analyser };
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

it("switches the actual capture, discards a stale pending stream, and stops when the chosen device disappears", async () => {
  const devices = [
    { kind: "audioinput", deviceId: "default", label: "Default" },
    { kind: "audioinput", deviceId: "one", label: "First microphone" },
    { kind: "audioinput", deviceId: "two", label: "Second microphone" },
  ] as MediaDeviceInfo[];
  const tracks = Array.from({ length: 3 }, () => ({ stop: vi.fn(), onended: null }));
  const streams = tracks.map(track => ({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream));
  let release!: (stream: MediaStream) => void;
  const request = vi.fn()
    .mockResolvedValueOnce(streams[0])
    .mockImplementationOnce(() => new Promise<MediaStream>(resolve => { release = resolve; }))
    .mockResolvedValueOnce(streams[2]);
  const { mediaDevices } = microphone(request, devices);
  const view = render(() => <MicrophoneTuner />);
  const picker = screen.getByRole("combobox", { name: "Microphone input" });
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start microphone pitch detection" }));
  await screen.findByRole("option", { name: "First microphone" });
  fireEvent.change(picker, { target: { value: "one" } });
  expect(tracks[0].stop).toHaveBeenCalledOnce();
  fireEvent.change(picker, { target: { value: "two" } });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[1][0].audio.deviceId).toEqual({ exact: "one" });
  expect(request.mock.calls[2][0].audio.deviceId).toEqual({ exact: "two" });
  release(streams[1]);
  await waitFor(() => expect(tracks[1].stop).toHaveBeenCalledOnce());
  await screen.findByText("Listening for a clear note…");
  devices.splice(2, 1);
  mediaDevices.dispatchEvent(new Event("devicechange"));
  await waitFor(() => expect(tracks[2].stop).toHaveBeenCalledOnce());
  expect(screen.getByRole("alert")).toHaveTextContent(/selected microphone.*(unavailable|disconnected)/i);
  expect(picker).toHaveValue("two");
  view.unmount();
});

it("keeps the selected microphone after permission denial without falling back to default", async () => {
  const devices = [{ kind: "audioinput", deviceId: "one", label: "USB microphone" }] as MediaDeviceInfo[];
  const track = { stop: vi.fn(), onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const request = vi.fn().mockResolvedValueOnce(stream).mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  microphone(request, devices);
  render(() => <MicrophoneTuner />);
  fireEvent.click(screen.getByRole("button", { name: "Start microphone pitch detection" }));
  await screen.findByRole("option", { name: "USB microphone" });
  fireEvent.change(screen.getByRole("combobox", { name: "Microphone input" }), { target: { value: "one" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(/permission was denied/i);
  expect(screen.getByRole("combobox", { name: "Microphone input" })).toHaveValue("one");
  expect(request).toHaveBeenCalledTimes(2);
  expect(track.stop).toHaveBeenCalledOnce();
});

it("emits every real analysis tick, silence, and the stop boundary", async () => {
  const track = { stop: vi.fn(), onended: null };
  const incoming = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const { analyser } = microphone(() => Promise.resolve(incoming));
  let silent = false;
  analyser.getFloatTimeDomainData.mockImplementation((samples: Float32Array) => {
    for (let i = 0; i < samples.length; i++) samples[i] = silent ? 0 : 0.25 * Math.sin(2 * Math.PI * 329.6275569 * i / 48000);
  });
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
  const onSample = vi.fn();
  const view = render(() => <MicrophoneTuner onSample={onSample} />);
  fireEvent.click(screen.getByRole("button", { name: "Start microphone pitch detection" }));
  await screen.findByText("Listening for a clear note…");
  expect(onSample).toHaveBeenLastCalledWith(null, false);
  frame(50);
  frame(100);
  expect(onSample.mock.calls.slice(-2)).toEqual([
    [expect.objectContaining({ midi: 64, cents: 0 }), true],
    [expect.objectContaining({ midi: 64, cents: 0 }), true],
  ]);
  silent = true;
  frame(150);
  expect(onSample).toHaveBeenLastCalledWith(null, true);
  fireEvent.click(screen.getByRole("button", { name: "Stop microphone pitch detection" }));
  expect(onSample).toHaveBeenLastCalledWith(null, false);
  view.unmount();
});
