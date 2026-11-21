import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobDTO, LearningDocument, LearningPreferences } from "~/api";
import * as api from "~/api";
import LearnLyrics from "./LearnLyrics";

vi.mock("~/api", async importOriginal => {
  const actual = await importOriginal<typeof import("~/api")>();
  return { ...actual, learningProgress: vi.fn(), saveLearningPreferences: vi.fn(), reviewLearningLine: vi.fn() };
});

function fixture(): LearningDocument {
  return {
    document_version: "doc", saving_available: true,
    lines: [
      { id: "one", text: "e\u0301lan 東京", onset_s: 1, end_s: 3, onset_source: "provider-synced" },
      { id: "two", text: "Unknown line", onset_s: null, end_s: null, onset_source: "unknown" },
    ],
    sections: [{ id: "verse", label: "verse", start_s: 1, end_s: 3 }],
    progress: { hint_level: "full", section_id: null, line_id: "one", difficulties: {} },
  };
}
const job = { id: 3, has_original: true } as JobDTO;
let state: LearningDocument;

beforeEach(() => {
  state = fixture();
  vi.mocked(api.learningProgress).mockImplementation(async () => structuredClone(state));
  vi.mocked(api.saveLearningPreferences).mockImplementation(async (_id, update: LearningPreferences) => {
    const { document_version: _, ...changes } = update;
    state = { ...state, progress: { ...state.progress, ...changes } };
    return structuredClone(state);
  });
  vi.mocked(api.reviewLearningLine).mockImplementation(async (_id, _version, line, rating) => {
    state = { ...state, progress: { ...state.progress, line_id: "two", difficulties: { [line]: rating === "forgot" ? 3 : 1 } } };
    return structuredClone(state);
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("guides listening through hints, reveal and a server-selected difficult-line review", async () => {
  render(() => <LearnLyrics job={job} />);
  expect(await screen.findByText("e\u0301lan 東京")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Practice" }));
  const practice = await screen.findByRole("region", { name: "Practice line" });
  expect(within(practice).getByRole("button", { name: "Reveal word 1" })).toHaveTextContent("e\u0301l••");
  fireEvent.click(screen.getByRole("button", { name: "Fewer hints" }));
  await waitFor(() => expect(within(practice).getByRole("button", { name: "Reveal word 1" })).toHaveTextContent("e\u0301•••"));
  fireEvent.click(screen.getByRole("button", { name: "Fewer hints" }));
  await waitFor(() => expect(within(practice).getByRole("button", { name: "Reveal word 1" })).toHaveTextContent("••••"));
  fireEvent.click(within(practice).getByRole("button", { name: "Reveal word 1" }));
  expect(within(practice).getByRole("button", { name: /Word 1/ })).toHaveTextContent("e\u0301lan");
  fireEvent.click(screen.getByRole("button", { name: "Reveal line" }));
  expect(within(practice).getByRole("button", { name: /Word 2/ })).toHaveTextContent("東京");
  fireEvent.click(screen.getByRole("button", { name: "Forgot" }));
  await waitFor(() => expect(api.reviewLearningLine).toHaveBeenCalledWith(3, "doc", "one", "forgot"));
  expect(await screen.findByText(/No supported line timing/)).toBeVisible();
});

it("allows untimed manual practice without claiming persistence when the source is unavailable", async () => {
  state.saving_available = false;
  render(() => <LearnLyrics job={job} />);
  expect(await screen.findByText(/Saving unavailable/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Practice" }));
  fireEvent.click(screen.getByRole("button", { name: "Line 2 (unplaced)" }));
  expect(screen.getByText(/No supported line timing/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Forgot" })).toBeDisabled();
  expect(api.saveLearningPreferences).not.toHaveBeenCalled();
});

it("repeats only the selected line and stops on unmount", async () => {
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { configurable: true, value: 8 });
  Object.defineProperty(audio, "paused", { configurable: true, value: false });
  fireEvent.loadedMetadata(audio);
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "verse" } });
  await waitFor(() => expect(api.saveLearningPreferences).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Repeat line" }));
  expect(audio.currentTime).toBe(1);
  audio.currentTime = 3;
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBe(1);
  rendered.unmount();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});

it("ignores a late progress response after the learning view closes", async () => {
  const { promise, resolve } = Promise.withResolvers<LearningDocument>();
  vi.mocked(api.learningProgress).mockReturnValue(promise);
  const rendered = render(() => <LearnLyrics job={job} />);
  rendered.unmount();
  resolve(fixture());
  await promise;
  expect(screen.queryByText("e\u0301lan 東京")).not.toBeInTheDocument();
});

it("never enables an out-of-recording section or line seek", async () => {
  state.sections[0].end_s = 9;
  state.lines[0].onset_s = 9;
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { configurable: true, value: 8 });
  fireEvent.loadedMetadata(audio);
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "verse" } });
  await waitFor(() => expect(screen.getByLabelText("Practice section")).toBeEnabled());
  expect(screen.getByRole("button", { name: "Repeat line" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Practice" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Practice" }));
  expect(await screen.findByRole("button", { name: "Seek to line" })).toBeDisabled();
});

it("cannot reenable line repeat while a section change is pending", async () => {
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { configurable: true, value: 8 });
  fireEvent.loadedMetadata(audio);
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "verse" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Repeat line" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Repeat line" }));
  const pending = Promise.withResolvers<LearningDocument>();
  vi.mocked(api.saveLearningPreferences).mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Repeat line" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Repeat line" })).toHaveAttribute("aria-pressed", "false");
  pending.resolve({ ...state, progress: { ...state.progress, section_id: null } });
  await pending.promise;
});

it("shows a failed save and ignores a late mutation after closing", async () => {
  const pending = Promise.withResolvers<LearningDocument>();
  vi.mocked(api.saveLearningPreferences).mockRejectedValueOnce(new Error("offline"));
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  fireEvent.click(screen.getByRole("button", { name: "Practice" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Changes were not saved. offline");
  expect(screen.getByText("Full lyrics")).toBeVisible();
  vi.mocked(api.saveLearningPreferences).mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Practice" }));
  rendered.unmount();
  pending.resolve({ ...fixture(), progress: { ...fixture().progress, hint_level: "partial" } });
  await pending.promise;
  expect(screen.queryByText("Partial words")).not.toBeInTheDocument();
});

it("seeks changed lines on the original clock without starting paused audio", async () => {
  state.lines[1] = { ...state.lines[1], onset_s: 4, end_s: 6, onset_source: "acoustic" };
  const rendered = render(() => <LearnLyrics job={{ ...job, options: { tempo_percent: 125 } } as JobDTO} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { configurable: true, value: 8 });
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Unknown line" }));
  await waitFor(() => expect(audio.currentTime).toBe(4));
  expect(audio.paused).toBe(true);
});

it("stops at the next onset, restarts on replay and uses duration for the last line", async () => {
  state.lines[0].end_s = null;
  state.lines[1] = { ...state.lines[1], onset_s: 4, end_s: null, onset_source: "acoustic" };
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  let paused = false;
  Object.defineProperties(audio, {
    duration: { configurable: true, value: 8 },
    paused: { configurable: true, get: () => paused },
  });
  vi.mocked(audio.pause).mockImplementation(() => { paused = true; });
  fireEvent.loadedMetadata(audio);
  audio.currentTime = 2;
  paused = true;
  fireEvent.pause(audio);
  paused = false;
  fireEvent.play(audio);
  expect(audio.currentTime).toBe(2);
  fireEvent.play(audio);
  audio.currentTime = 4;
  fireEvent.timeUpdate(audio);
  expect(paused).toBe(true);
  expect(audio.currentTime).toBe(4);
  paused = false;
  fireEvent.play(audio);
  expect(audio.currentTime).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Unknown line" }));
  await waitFor(() => expect(audio.currentTime).toBe(4));
  expect(paused).toBe(false);
  audio.currentTime = 8;
  fireEvent.timeUpdate(audio);
  expect(paused).toBe(true);
  expect(audio.currentTime).toBe(8);
});

it("pauses rather than playing an unbounded untimed line", async () => {
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { configurable: true, value: 8 });
  fireEvent.loadedMetadata(audio);
  fireEvent.click(screen.getByRole("button", { name: "Unknown line (unplaced)" }));
  expect(await screen.findByText(/no supported playback bounds/i)).toBeVisible();
  fireEvent.play(audio);
  expect(audio.pause).toHaveBeenCalled();
});

it("keeps the old line bound while selection is awaiting a save", async () => {
  state.lines[1] = { ...state.lines[1], onset_s: 4, end_s: 6, onset_source: "acoustic" };
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  let paused = false;
  Object.defineProperties(audio, { duration: { configurable: true, value: 8 }, paused: { configurable: true, get: () => paused } });
  vi.mocked(audio.pause).mockImplementation(() => { paused = true; });
  fireEvent.loadedMetadata(audio);
  const pending = Promise.withResolvers<LearningDocument>();
  vi.mocked(api.saveLearningPreferences).mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Unknown line" }));
  audio.currentTime = 3;
  fireEvent.timeUpdate(audio);
  expect(paused).toBe(true);
  expect(audio.currentTime).toBe(3);
  pending.resolve({ ...state, progress: { ...state.progress, line_id: "two" } });
  await waitFor(() => expect(audio.currentTime).toBe(4));
  expect(paused).toBe(true);
});

it("uses chronological cues when an earlier ASR extra follows canonical lines in display order", async () => {
  state.lines = [
    { id: "one", text: "Canonical", onset_s: 4, end_s: null, onset_source: "provider-synced" },
    { id: "extra", text: "Earlier extra", onset_s: 1, end_s: 2, onset_source: "acoustic" },
    { id: "later", text: "Later cue", onset_s: 6, end_s: null, onset_source: "provider-synced" },
  ];
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  let paused = false;
  Object.defineProperties(audio, { duration: { configurable: true, value: 8 }, paused: { configurable: true, get: () => paused } });
  vi.mocked(audio.pause).mockImplementation(() => { paused = true; });
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(4);
  audio.currentTime = 6;
  fireEvent.timeUpdate(audio);
  expect(paused).toBe(true);
  expect(audio.currentTime).toBe(6);
});

it("uses recording duration for the chronologically last line even if an earlier extra follows it", async () => {
  state.lines[0] = { ...state.lines[0], onset_s: 4, end_s: null };
  state.lines[1] = { ...state.lines[1], onset_s: 1, end_s: 2, onset_source: "acoustic" };
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperties(audio, { duration: { configurable: true, value: 8 }, paused: { configurable: true, value: false } });
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(4);
  audio.currentTime = 8;
  fireEvent.timeUpdate(audio);
  expect(audio.pause).toHaveBeenCalled();
  expect(audio.currentTime).toBe(8);
});

it("does not skip an intervening untimed line to claim a later cutoff", async () => {
  state.lines[0].end_s = null;
  state.lines.push({ id: "later", text: "Later", onset_s: 6, end_s: null, onset_source: "provider-synced" });
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { configurable: true, value: 8 });
  fireEvent.loadedMetadata(audio);
  expect(screen.getByText(/no supported playback bounds/i)).toBeVisible();
  expect(screen.getByRole("button", { name: "Repeat line" })).toBeDisabled();
});

it("rearms the fallback boundary timer after changing lines during playback", async () => {
  state.lines[1] = { ...state.lines[1], onset_s: 4, end_s: 5, onset_source: "acoustic" };
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  let paused = false;
  Object.defineProperties(audio, { duration: { configurable: true, value: 8 }, paused: { configurable: true, get: () => paused } });
  vi.mocked(audio.pause).mockImplementation(() => { paused = true; });
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  fireEvent.loadedMetadata(audio);
  vi.useFakeTimers();
  try {
    fireEvent.play(audio);
    fireEvent.click(screen.getByRole("button", { name: "Unknown line" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.currentTime).toBe(4);
    fireEvent.seeked(audio);
    audio.currentTime = 5;
    vi.advanceTimersByTime(1000);
    expect(paused).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
