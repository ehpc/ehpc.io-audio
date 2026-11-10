import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { PitchNoteDTO } from "~/api";
import PianoKeyboard from "./PianoKeyboard";

const note: PitchNoteDTO = { start_s: 1, end_s: 2, midi: 61.25, frequency_hz: 281, note: "C#4", cents: 25, confidence: 0.9, word_indices: [] };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("highlights rounded detected notes only while playing and within the half-open interval", () => {
  const [position, setPosition] = createSignal(1);
  const [playing, setPlaying] = createSignal(false);
  render(() => <PianoKeyboard notes={[note]} rangeNotes={[note]} position={position()} playing={playing()} />);
  const key = screen.getByRole("button", { name: "Piano C#4" });
  expect(key).toHaveAttribute("aria-pressed", "false");
  setPlaying(true);
  expect(key).toHaveAttribute("aria-pressed", "true");
  setPosition(2);
  expect(key).toHaveAttribute("aria-pressed", "false");
  setPosition(1.5);
  setPlaying(false);
  expect(key).toHaveAttribute("aria-pressed", "false");
});

it("adjusts the accessible piano control without creating audio", () => {
  const constructor = vi.fn();
  vi.stubGlobal("AudioContext", constructor);
  render(() => <PianoKeyboard notes={[note]} rangeNotes={[note]} position={0} playing={false} />);
  const slider = screen.getByRole("slider", { name: "Piano volume" });
  fireEvent.input(slider, { target: { value: "0" } });
  expect(slider).toHaveAttribute("aria-valuetext", "0%");
  expect(constructor).not.toHaveBeenCalled();
  fireEvent.input(slider, { target: { value: "65" } });
  expect(slider).toHaveAttribute("aria-valuetext", "65%");
});


it("cancels a pending audio resume on release, and suppresses held space repeat", async () => {
  vi.useFakeTimers();
  let resume!: () => void;
  const context = { state: "suspended", resume: () => new Promise<void>(resolve => { resume = resolve; }), createGain: vi.fn(), close: () => Promise.resolve(), suspend: vi.fn(() => Promise.resolve()) };
  vi.stubGlobal("AudioContext", vi.fn(() => context));
  render(() => <PianoKeyboard notes={[]} rangeNotes={[]} position={0} playing={false} />);
  const key = screen.getByRole("button", { name: "Piano C4" });
  const bubbling = vi.fn();
  document.addEventListener("keydown", bubbling);
  fireEvent.keyDown(key, { key: " " });
  fireEvent.keyDown(key, { key: " ", repeat: true });
  expect(key).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyUp(key, { key: " " });
  vi.advanceTimersByTime(250);
  context.state = "running";
  resume();
  await Promise.resolve();
  vi.advanceTimersByTime(250);
  expect(context.suspend).toHaveBeenCalledOnce();
  expect(context.createGain).not.toHaveBeenCalled();
  expect(key).toHaveAttribute("aria-pressed", "false");
  expect(bubbling).not.toHaveBeenCalled();
  document.removeEventListener("keydown", bubbling);
});

it("keeps the held key and song layout stable if analysis changes until release", () => {
  const context = { state: "suspended", resume: () => new Promise<void>(() => {}), close: () => Promise.resolve() };
  vi.stubGlobal("AudioContext", vi.fn(() => context));
  const [range, setRange] = createSignal([note]);
  const { container } = render(() => <PianoKeyboard notes={[note]} rangeNotes={range()} position={0} playing={false} />);
  const key = container.querySelector<HTMLButtonElement>(".piano-key-white")!;
  const before = [...container.querySelectorAll<HTMLButtonElement>(".piano-key")].map(button => [button, button.style.left]);
  fireEvent.keyDown(key, { key: " " });
  setRange([{ ...note, midi: 90 }]);
  expect(key).toHaveAttribute("aria-pressed", "true");
  expect([...container.querySelectorAll<HTMLButtonElement>(".piano-key")].map(button => [button, button.style.left])).toEqual(before);
  fireEvent.keyUp(key, { key: " " });
  expect(screen.getByRole("button", { name: "Piano F#6" })).toBeInTheDocument();
});
