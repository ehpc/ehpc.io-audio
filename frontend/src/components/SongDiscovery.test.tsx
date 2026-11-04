import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "~/api";
import SubmitForm from "./SubmitForm";
import type { QueryRecognition } from "./VoiceQuery";

vi.mock("~/api", async (original) => ({
  ...await original<typeof api>(), searchSong: vi.fn(), analyzeKey: vi.fn(), submitJob: vi.fn(),
}));
const match: api.SongMatch = {
  title: "First Love", artists: ["宇多田ヒカル"], url: "https://music.youtube.com/watch?v=o1sUaVJUeB0", duration_seconds: 258,
};
const chooseSearch = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Find song", exact: true }));
  return screen.getByLabelText("Describe a song");
};
const search = () => userEvent.click(screen.getByRole("button", { name: "Search", exact: true }));
const process = () => userEvent.click(screen.getByRole("button", { name: /Process audio|Download song/, exact: true }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.searchSong).mockResolvedValue(match);
  vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: "C major" });
  vi.mocked(api.submitJob).mockResolvedValue({ id: 9, status: "queued", position: 1 });
});
afterEach(() => vi.unstubAllGlobals());

it("finds only explicitly, analyzes the canonical match, and retains source/options after processing", async () => {
  const onSubmitted = vi.fn();
  render(() => <SubmitForm onSubmitted={onSubmitted} />);
  const query = await chooseSearch();
  fireEvent.input(query, { target: { value: "宇多田ヒカル first love" } });
  fireEvent.keyDown(query, { key: "Enter" });
  expect(api.searchSong).not.toHaveBeenCalled();
  expect(api.submitJob).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("checkbox", { name: "Extract vocals", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Drums", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Bass", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Add mix", exact: true }));
  await search();
  expect(await screen.findByText("First Love", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText("宇多田ヒカル")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Verify on YouTube Music/ })).toHaveAttribute("href", match.url);
  await screen.findByText("Original key: C major");
  expect(api.analyzeKey).toHaveBeenCalledWith({ url: match.url }, expect.any(AbortSignal));
  expect(api.submitJob).not.toHaveBeenCalled();
  await process();
  expect(api.submitJob).toHaveBeenCalledWith(expect.objectContaining({ url: match.url, file: undefined,
    options: expect.objectContaining({ extract_vocals: true, mixes: [expect.objectContaining({ components: ["drums", "bass"] })] }),
  }));
  expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ source_type: "url", source_value: match.url }));
  expect(query).toHaveValue("宇多田ヒカル first love");
  expect(screen.getByRole("button", { name: "Find song" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("link", { name: /Verify on YouTube Music/ })).toBeInTheDocument();
});

it("rejects empty input, shows provider errors, and retries without processing an old match", async () => {
  render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  fireEvent.input(query, { target: { value: "   " } });
  await search();
  expect(screen.getByRole("alert")).toHaveTextContent("Describe a song");
  expect(api.searchSong).not.toHaveBeenCalled();
  fireEvent.input(query, { target: { value: "first love" } });
  await search();
  await screen.findByText("First Love", { selector: "strong" });
  fireEvent.input(query, { target: { value: "an ambiguous song" } });
  expect(screen.queryByRole("link", { name: /Verify/ })).not.toBeInTheDocument();
  vi.mocked(api.searchSong).mockRejectedValueOnce(new Error("No matching song was found."));
  await search();
  expect(screen.getByRole("alert")).toHaveTextContent("No matching song was found.");
  await process();
  expect(api.submitJob).not.toHaveBeenCalled();
  await search();
  await screen.findByText("First Love", { selector: "strong" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("invalidates pending searches and keys on edits, clear selection, source changes, and unmount", async () => {
  const old = Promise.withResolvers<api.SongMatch>();
  const current = Promise.withResolvers<api.SongMatch>();
  const staleKey = Promise.withResolvers<api.KeyAnalysis>();
  vi.mocked(api.searchSong).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  vi.mocked(api.analyzeKey).mockReturnValueOnce(staleKey.promise);
  const view = render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  fireEvent.input(query, { target: { value: "old" } });
  await search();
  expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Finding on YouTube Music");
  fireEvent.input(query, { target: { value: "current" } });
  expect(vi.mocked(api.searchSong).mock.calls[0][1].aborted).toBe(true);
  await search();
  current.resolve(match);
  await screen.findByText("First Love", { selector: "strong" });
  await waitFor(() => expect(api.analyzeKey).toHaveBeenCalledOnce());
  old.resolve({ ...match, title: "Obsolete" });
  await Promise.resolve();
  expect(screen.queryByText("Obsolete")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(vi.mocked(api.analyzeKey).mock.calls[0][1].aborted).toBe(true);
  staleKey.resolve({ original_key: "G major" });
  await Promise.resolve();
  expect(screen.queryByText("Original key: G major")).not.toBeInTheDocument();
  await process();
  expect(api.submitJob).not.toHaveBeenCalled();
  const changingSource = Promise.withResolvers<api.SongMatch>();
  vi.mocked(api.searchSong).mockReturnValueOnce(changingSource.promise);
  await search();
  await userEvent.click(screen.getByRole("button", { name: "From URL" }));
  expect(vi.mocked(api.searchSong).mock.calls[2][1].aborted).toBe(true);
  changingSource.resolve(match);
  await chooseSearch();
  expect(screen.getByLabelText("Describe a song")).toHaveValue("current");
  expect(screen.queryByRole("link", { name: /Verify/ })).not.toBeInTheDocument();
  vi.mocked(api.searchSong).mockReturnValueOnce(new Promise(() => {}));
  await search();
  const signal = vi.mocked(api.searchSong).mock.calls[3][1];
  view.unmount();
  expect(signal.aborted).toBe(true);
});

it("keeps the independent URL and upload drafts when choosing discovery", async () => {
  render(() => <SubmitForm onSubmitted={vi.fn()} />);
  fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.com/draft" } });
  await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
  await userEvent.upload(screen.getByLabelText("Audio file"), new File(["audio"], "draft.wav", { type: "audio/wav" }));
  await chooseSearch();
  await userEvent.click(screen.getByRole("button", { name: "From URL" }));
  expect(screen.getByLabelText("Track URL")).toHaveValue("https://example.com/draft");
  await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
  expect(screen.getByText("Selected: draft.wav")).toBeInTheDocument();
});

it("dictates without searching, ignores late speech after typing, and aborts when leaving discovery", async () => {
  let recognition!: QueryRecognition;
  vi.stubGlobal("SpeechRecognition", class {
    constructor() { recognition = this as unknown as QueryRecognition; }
    start = vi.fn(); stop = vi.fn(); abort = vi.fn();
  });
  render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  recognition.onresult?.({ results: [[{ transcript: "First Love 宇多田ヒカル" }]] });
  expect(query).toHaveValue("First Love 宇多田ヒカル");
  expect(api.searchSong).not.toHaveBeenCalled();
  expect(api.analyzeKey).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  const late = recognition.onresult;
  fireEvent.input(query, { target: { value: "typed song" } });
  expect(recognition.abort).toHaveBeenCalledOnce();
  late?.({ results: [[{ transcript: "stale song" }]] });
  expect(query).toHaveValue("typed song");
  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  const active = recognition;
  await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
  expect(active.abort).toHaveBeenCalledOnce();
  expect(api.submitJob).not.toHaveBeenCalled();
});
