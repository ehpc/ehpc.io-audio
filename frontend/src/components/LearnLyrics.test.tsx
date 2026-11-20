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
      { id: "one", text: "e\u0301lan 東京", onset_s: 1, end_s: null, onset_source: "provider-synced" },
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

it("repeats only a selected supported section and stops on unmount", async () => {
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { configurable: true, value: 8 });
  fireEvent.loadedMetadata(audio);
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "verse" } });
  await waitFor(() => expect(api.saveLearningPreferences).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Repeat section" }));
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
  await waitFor(() => expect(screen.getByText(/falls outside the recording/)).toBeVisible());
  expect(screen.getByRole("button", { name: "Repeat section" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Practice" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Practice" }));
  expect(await screen.findByRole("button", { name: "Seek to line" })).toBeDisabled();
});

it("cannot reenable repeat while a section change is pending", async () => {
  const rendered = render(() => <LearnLyrics job={job} />);
  await screen.findByRole("button", { name: "Practice" });
  const audio = rendered.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { configurable: true, value: 8 });
  fireEvent.loadedMetadata(audio);
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "verse" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Repeat section" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Repeat section" }));
  const pending = Promise.withResolvers<LearningDocument>();
  vi.mocked(api.saveLearningPreferences).mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByLabelText("Practice section"), { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Repeat section" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Repeat section" })).toHaveAttribute("aria-pressed", "false");
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
