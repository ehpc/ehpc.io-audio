import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
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
  thumbnail_url: null, play_count: null, play_count_approximate: false,
};
const versions: api.SongMatch[] = [
  { ...match, thumbnail_url: "https://i.ytimg.com/vi/o1sUaVJUeB0/default.jpg", play_count: 123456 },
  { ...match, title: "First Love (Dance Remix)", url: "https://music.youtube.com/watch?v=remix123456", duration_seconds: 305, play_count: 0 },
  { ...match, title: "First Love (Live)", url: "https://music.youtube.com/watch?v=live1234567", duration_seconds: null,
    thumbnail_url: "https://i.ytimg.com/vi/live1234567/default.jpg" },
];
const chooseSearch = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Find song", exact: true }));
  return screen.getByLabelText("Describe a song");
};
const search = () => userEvent.click(screen.getByRole("button", { name: "Search", exact: true }));
const process = () => userEvent.click(screen.getByRole("button", { name: /Process audio|Download song/, exact: true }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.searchSong).mockResolvedValue([match]);
  vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: "C major" });
  vi.mocked(api.submitJob).mockResolvedValue({ id: 9, status: "queued", position: 1 });
});
afterEach(() => vi.unstubAllGlobals());

it("finds only explicitly, analyzes the canonical match, and retains source/options after processing", async () => {
  const onSubmitted = vi.fn();
  render(() => <SubmitForm onSubmitted={onSubmitted} />);
  const query = await chooseSearch();
  fireEvent.input(query, { target: { value: "宇多田ヒカル first love" } });
  expect(api.submitJob).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("checkbox", { name: "Extract vocals", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Drums", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Bass", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Add mix", exact: true }));
  await search();
  expect(await screen.findByText("First Love", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText("宇多田ヒカル")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Verify .* on YouTube Music/ })).toHaveAttribute("href", match.url);
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  expect(screen.getByRole("radio")).toBeChecked();
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
  expect(screen.getByRole("link", { name: /Verify .* on YouTube Music/ })).toBeInTheDocument();
});

it("switches versions without submitting, cancels stale key analysis, and processes only the chosen version", async () => {
  vi.mocked(api.searchSong).mockResolvedValue(versions);
  const firstKey = Promise.withResolvers<api.KeyAnalysis>();
  const remixKey = Promise.withResolvers<api.KeyAnalysis>();
  vi.mocked(api.analyzeKey).mockReturnValueOnce(firstKey.promise).mockReturnValueOnce(remixKey.promise);
  const onSubmitted = vi.fn();
  render(() => <SubmitForm onSubmitted={onSubmitted} />);
  const query = await chooseSearch();
  fireEvent.input(query, { target: { value: "first love versions" } });
  await search();
  const choices = screen.getAllByRole("radio");
  expect(choices).toHaveLength(3);
  expect(choices[0]).toBeChecked();
  await waitFor(() => expect(api.analyzeKey).toHaveBeenCalledOnce());
  const firstSignal = vi.mocked(api.analyzeKey).mock.calls[0][1];
  await userEvent.click(screen.getByRole("radio", { name: /Dance Remix/ }));
  await waitFor(() => expect(api.analyzeKey).toHaveBeenCalledTimes(2));
  expect(firstSignal.aborted).toBe(true);
  expect(api.analyzeKey).toHaveBeenLastCalledWith({ url: versions[1].url }, expect.any(AbortSignal));
  firstKey.resolve({ original_key: "G major" });
  await Promise.resolve();
  expect(screen.queryByText("Original key: G major")).not.toBeInTheDocument();
  remixKey.resolve({ original_key: "F minor" });
  await screen.findByText("Original key: F minor");
  expect(api.submitJob).not.toHaveBeenCalled();
  await process();
  expect(api.submitJob).toHaveBeenCalledWith(expect.objectContaining({ url: versions[1].url, file: undefined }));
  expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ source_value: versions[1].url, source_type: "url" }));
  expect(screen.getByRole("radio", { name: /Dance Remix/ })).toBeChecked();
  fireEvent.input(query, { target: { value: "different song" } });
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(screen.queryByText("Original key: F minor")).not.toBeInTheDocument();
});

it.each([
  [123456, false, "123,456"],
  [2700000000, true, "About 2.7B"],
] as const)("renders %s plays truthfully, distinguishes unknown/zero, and keeps missing or broken art selectable", async (count, approximate, displayed) => {
  vi.mocked(api.searchSong).mockResolvedValue([{ ...versions[0], play_count: count, play_count_approximate: approximate }, ...versions.slice(1)]);
  const view = render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  fireEvent.input(query, { target: { value: "first love versions" } });
  await search();
  const choices = screen.getAllByRole("radio");
  expect(choices.map(choice => choice.closest("label")?.textContent)).toEqual([
    expect.stringContaining("First Love"), expect.stringContaining("Dance Remix"), expect.stringContaining("Live"),
  ]);
  const original = within(choices[0].closest("label")!);
  expect(original.getByText(`${displayed} YouTube Music plays`)).toBeVisible();
  expect(original.getByText("4:18")).toBeVisible();
  expect(within(choices[1].closest("label")!).getByText("0 YouTube Music plays")).toBeVisible();
  expect(within(choices[1].closest("label")!).getByText("5:05")).toBeVisible();
  expect(choices[2].closest("label")).not.toHaveTextContent("0 YouTube Music plays");
  expect(within(choices[2].closest("label")!).getAllByText(/unavailable/i)).toHaveLength(2);
  const images = view.container.querySelectorAll("img");
  expect(images).toHaveLength(2);
  expect(images[0].src).toBe(versions[0].thumbnail_url);
  expect(screen.queryByRole("img")).not.toBeInTheDocument(); // artwork is decorative beside the song identity
  fireEvent.error(images[1]);
  expect(view.container.querySelectorAll("img")).toHaveLength(1);
  await userEvent.click(choices[2]);
  expect(choices[2]).toBeChecked();
  await waitFor(() => expect(api.analyzeKey).toHaveBeenLastCalledWith({ url: versions[2].url }, expect.any(AbortSignal)));
  expect(api.submitJob).not.toHaveBeenCalled();
});

it("selects versions with native radio keys and Enter without invoking the audio form", async () => {
  vi.mocked(api.searchSong).mockResolvedValue(versions);
  render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  await userEvent.type(query, "first love{Enter}");
  const choices = await screen.findAllByRole("radio");
  choices[0].focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(choices[1]).toBeChecked();
  await waitFor(() => expect(api.analyzeKey).toHaveBeenLastCalledWith({ url: versions[1].url }, expect.any(AbortSignal)));
  choices[2].focus();
  await userEvent.keyboard(" ");
  expect(choices[2]).toBeChecked();
  await userEvent.keyboard("{Enter}");
  expect(api.submitJob).not.toHaveBeenCalled();
  expect(api.searchSong).toHaveBeenCalledOnce();
  await waitFor(() => expect(api.analyzeKey).toHaveBeenLastCalledWith({ url: versions[2].url }, expect.any(AbortSignal)));
});

it("searches on Enter without submitting audio or duplicating a pending search", async () => {
  const pending = Promise.withResolvers<api.SongMatch[]>();
  vi.mocked(api.searchSong).mockReturnValueOnce(pending.promise);
  render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  await userEvent.type(query, "宇多田ヒカル first love");
  expect(api.searchSong).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(api.searchSong).toHaveBeenCalledOnce();
  const signal = vi.mocked(api.searchSong).mock.calls[0][1];
  expect(screen.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  fireEvent.keyDown(query, { key: "Enter", repeat: true });
  expect(api.searchSong).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(false);
  expect(api.submitJob).not.toHaveBeenCalled();
  pending.resolve([match]);
  expect(await screen.findByRole("link", { name: /Verify .* on YouTube Music/ })).toHaveAttribute("href", match.url);
  await screen.findByText("Original key: C major");
  expect(api.analyzeKey).toHaveBeenCalledWith({ url: match.url }, expect.any(AbortSignal));
  fireEvent.keyDown(query, { key: "Enter", repeat: true });
  expect(api.searchSong).toHaveBeenCalledOnce();
  expect(api.submitJob).not.toHaveBeenCalled();
});

it("ignores IME Enter and uses the same empty-query and retry behavior for keyboard searches", async () => {
  render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  await userEvent.type(query, "   ");
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("alert")).toBeVisible();
  expect(api.searchSong).not.toHaveBeenCalled();
  expect(api.submitJob).not.toHaveBeenCalled();
  fireEvent.input(query, { target: { value: "宇多田ヒカル" } });
  fireEvent.keyDown(query, { key: "Enter", isComposing: true });
  // Safari can report composition completion as Enter with legacy code 229.
  fireEvent.keyDown(query, { key: "Enter", keyCode: 229 });
  expect(api.searchSong).not.toHaveBeenCalled();
  expect(api.submitJob).not.toHaveBeenCalled();
  vi.mocked(api.searchSong).mockRejectedValueOnce(new Error("Please specify a song title."));
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("Please specify a song title.");
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("link", { name: /Verify .* on YouTube Music/ })).toHaveAttribute("href", match.url);
  expect(api.searchSong).toHaveBeenCalledTimes(2);
  expect(api.submitJob).not.toHaveBeenCalled();
});

it("rejects empty input, shows provider errors, and retries without processing an old match", async () => {
  render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  fireEvent.input(query, { target: { value: "   " } });
  await search();
  expect(screen.getByRole("alert")).toBeVisible();
  expect(api.searchSong).not.toHaveBeenCalled();
  expect(api.submitJob).not.toHaveBeenCalled();
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
  const old = Promise.withResolvers<api.SongMatch[]>();
  const current = Promise.withResolvers<api.SongMatch[]>();
  const staleKey = Promise.withResolvers<api.KeyAnalysis>();
  vi.mocked(api.searchSong).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  vi.mocked(api.analyzeKey).mockReturnValueOnce(staleKey.promise);
  const view = render(() => <SubmitForm onSubmitted={vi.fn()} />);
  const query = await chooseSearch();
  fireEvent.input(query, { target: { value: "old" } });
  await search();
  expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  expect(screen.getByRole("status")).toBeVisible();
  expect(api.searchSong).toHaveBeenCalledOnce();
  fireEvent.input(query, { target: { value: "current" } });
  expect(vi.mocked(api.searchSong).mock.calls[0][1].aborted).toBe(true);
  await search();
  current.resolve([match]);
  await screen.findByText("First Love", { selector: "strong" });
  await waitFor(() => expect(api.analyzeKey).toHaveBeenCalledOnce());
  old.resolve([{ ...match, title: "Obsolete" }]);
  await Promise.resolve();
  expect(screen.queryByText("Obsolete")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(vi.mocked(api.analyzeKey).mock.calls[0][1].aborted).toBe(true);
  staleKey.resolve({ original_key: "G major" });
  await Promise.resolve();
  expect(screen.queryByText("Original key: G major")).not.toBeInTheDocument();
  await process();
  expect(api.submitJob).not.toHaveBeenCalled();
  const changingSource = Promise.withResolvers<api.SongMatch[]>();
  vi.mocked(api.searchSong).mockReturnValueOnce(changingSource.promise);
  await search();
  await userEvent.click(screen.getByRole("button", { name: "From URL" }));
  expect(vi.mocked(api.searchSong).mock.calls[2][1].aborted).toBe(true);
  changingSource.resolve([match]);
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
