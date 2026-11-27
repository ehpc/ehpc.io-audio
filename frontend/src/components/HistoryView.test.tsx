import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal, Show } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, deleteSong, getJob, type JobDTO, type SongSummary, type SongDetail } from "~/api";
import HistoryView from "./HistoryView";
import ResultsView from "./ResultsView";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.mocked(deleteSong).mockClear();
  vi.mocked(getJob).mockReset().mockResolvedValue({ id: 101, song_id: 1, result_revision: null, original_key: null } as JobDTO);
});

vi.mock("~/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api")>()),
  deleteSong: vi.fn(),
  getJob: vi.fn(),
}));

function urlJob(overrides: Partial<SongSummary> = {}): SongSummary {
  return {
    id: 1, status: "done", source_type: "url", source_value: "https://example.com/song",
    title: "Great Song", open_count: 0, created_at: 1700000000, has_original: true, original_key: null,
    original_work_id: 101, latest_work_id: 101, active_work_id: null, active_work_ids: [],
    availability: { audio: true, karaoke: false, lyrics: false, pitched_lyrics: false },
    ...overrides,
  };
}

function detail(summary: SongSummary): SongDetail {
  return { summary, variants: [] };
}

describe("HistoryView compact sidebar", () => {
  it("shows only the title, date and delete action without conflating selection with deletion", async () => {
    const title = "A Long Song Title That Must Stay Inside Its Library Item";
    const job = urlJob({ title });
    const [jobs, setJobs] = createSignal([job]);
    const [selectedId, setSelectedId] = createSignal<number | null>(null);
    const onSelect = vi.fn((item: SongSummary) => setSelectedId(item.id));
    const onDeleted = vi.fn((id: number) => setJobs(current => current.filter(item => item.id !== id)));
    vi.mocked(deleteSong).mockReset().mockResolvedValue(undefined);
    render(() => <HistoryView jobs={jobs()} selectedId={selectedId()} sort="usage" onSortChange={vi.fn()} onSelect={onSelect} onDeleted={onDeleted} />);

    const history = screen.getByRole("region", { name: "History" });
    const item = within(history).getByRole("listitem");
    const titleButton = within(item).getByRole("button", { name: title, exact: true });
    const deleteButton = within(item).getByRole("button", { name: `Delete ${title}` });
    expect(titleButton).toBeVisible();
    const date = within(item).getByText((_, element) => element?.tagName === "TIME");
    expect(date).toHaveAttribute("datetime", new Date(job.created_at * 1000).toISOString());
    expect(date.textContent?.trim()).not.toBe("");
    expect(item.textContent?.replace(/\s+/g, "")).toBe(`${title}${date.textContent?.trim()}Delete`.replace(/\s+/g, ""));
    expect(within(item).getAllByRole("button")).toEqual([titleButton, deleteButton]);

    titleButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(job);
    expect(titleButton).toHaveAttribute("aria-current", "true");
    await userEvent.click(deleteButton);
    expect(onSelect).toHaveBeenCalledTimes(1);
    let dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(`Delete ${title}?`);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteSong).not.toHaveBeenCalled();
    expect(within(history).getByRole("button", { name: title, exact: true })).toBeVisible();

    await userEvent.click(within(history).getByRole("button", { name: `Delete ${title}` }));
    dialog = screen.getByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete track" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(job.id));
    expect(deleteSong).toHaveBeenCalledWith(job.id);
    expect(within(history).queryByRole("listitem")).not.toBeInTheDocument();
  });
});
describe("HistoryView results", () => {
  it("keeps selected styling at the usage-sorted position instead of pinning selection first", () => {
    const mostUsed = urlJob({ id: 11, title: "Most Used", open_count: 8 });
    const selected = urlJob({ id: 12, title: "Selected", open_count: 1 });
    const [selectedId] = createSignal<number | null>(selected.id);
    render(() => <HistoryView jobs={[mostUsed, selected]} selectedId={selectedId()} sort="usage" onSortChange={vi.fn()} onSelect={vi.fn()}
      onDeleted={vi.fn()} />);
    const history = screen.getByRole("region", { name: "History" });
    const titles = () => within(history).getAllByRole("button").filter(button => /^(Most Used|Selected)$/.test(button.textContent ?? ""));
    expect(titles().map(button => button.textContent)).toEqual(["Most Used", "Selected"]);
    expect(titles()[0]).not.toHaveAttribute("aria-current");
    expect(titles()[1]).toHaveAttribute("aria-current", "true");
  });

  it("keeps delete keyboard focus through refreshed reordered jobs", async () => {
    const first = urlJob({ id: 11, title: "First" });
    const second = urlJob({ id: 12, title: "Second" });
    const [jobs, setJobs] = createSignal([first, second]);
    render(() => <HistoryView jobs={jobs()} sort="usage" onSortChange={vi.fn()} onSelect={vi.fn()} onDeleted={vi.fn()} />);
    const deletion = screen.getByRole("button", { name: "Delete Second" });
    deletion.focus();
    setJobs([{ ...second, open_count: 1 }, { ...first }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete Second" })).toHaveFocus());
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete Second?");
  });

  it("does not restore row focus over a newer focus choice", async () => {
    const first = urlJob({ id: 11, title: "First" });
    const second = urlJob({ id: 12, title: "Second" });
    const [jobs, setJobs] = createSignal([first, second]);
    render(() => <HistoryView jobs={jobs()} sort="usage" onSortChange={vi.fn()} onSelect={vi.fn()} onDeleted={vi.fn()} />);
    screen.getByRole("button", { name: "Delete Second" }).focus();
    setJobs([{ ...second }, { ...first }]);
    const sort = screen.getByRole("button", { name: "Sort library" });
    sort.focus();
    await Promise.resolve();
    expect(sort).toHaveFocus();
  });

  it("switches the server sort choice through the accessible popup radios", async () => {
    const [sort, setSort] = createSignal<"usage" | "added">("usage");
    render(() => <HistoryView jobs={[urlJob()]} sort={sort()} onSortChange={setSort} onSelect={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Sort library" }));
    const popup = screen.getByRole("dialog", { name: "Sort library options" });
    const usage = within(popup).getByRole("radio", { name: "Most used" });
    const added = within(popup).getByRole("radio", { name: "Date added (newest first)" });
    expect(usage).toBeChecked();
    await userEvent.click(added);
    expect(added).toBeChecked();
  });

  it("keeps the summary compact while preserving the original download in opened results", async () => {
    const song = urlJob();
    const [selected, setSelected] = createSignal<SongSummary | null>(null);
    render(() => <>
      <Show when={selected()}>{item => <ResultsView detail={detail(item())} onReset={() => setSelected(null)} refreshToken={0} onStaleDetail={vi.fn()} />}</Show>
      <HistoryView jobs={[song]} sort="usage" onSortChange={vi.fn()} onSelect={setSelected} onDeleted={vi.fn()} />
    </>);
    const history = screen.getByRole("region", { name: "History" });
    expect(within(history).queryByRole("link")).not.toBeInTheDocument();
    await userEvent.click(within(history).getByRole("button", { name: "Great Song", exact: true }));
    expect(screen.getByRole("link", { name: "Download original" })).toHaveAttribute("href", "/api/jobs/101/original");
  });

  it("selects a history track from its title and updates the result heading once", async () => {
    const [selected, setSelected] = createSignal<SongSummary | null>(null);
    const onSelect = vi.fn((item: SongSummary) => setSelected(item));
    const jobs = [urlJob({ id: 11, title: "First Song" }), urlJob({ id: 12, title: "Second Song" })];
    render(() => <>
      <Show when={selected()}>{item => <ResultsView detail={detail(item())} onReset={() => setSelected(null)} refreshToken={0} onStaleDetail={vi.fn()} />}</Show>
      <HistoryView jobs={jobs} sort="usage" onSortChange={vi.fn()} onSelect={onSelect} onDeleted={vi.fn()} />
    </>);

    const firstTitle = screen.getByRole("button", { name: "First Song", exact: true });
    firstTitle.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 2, name: "First Song" })).toBeVisible();
    expect(screen.getAllByText("First Song")).toHaveLength(2);

    const secondTitle = screen.getByRole("button", { name: "Second Song", exact: true });
    const secondRow = secondTitle.closest('[role="listitem"]');
    expect(secondRow).not.toBeNull();
    await userEvent.click(secondRow!);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { level: 2, name: "Second Song" })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 2, name: "First Song" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Second Song")).toHaveLength(2);
  });

  it("omits the original download when no original is available", () => {
    const song = urlJob({ has_original: false, original_work_id: null });
    render(() => <ResultsView detail={detail(song)} onReset={vi.fn()} refreshToken={0} onStaleDetail={vi.fn()} />);
    expect(screen.queryByRole("link", { name: "Download original" })).not.toBeInTheDocument();
  });

  it("keeps queued history to its title and date without delete", () => {
    const job = urlJob({ status: "queued", active_work_id: 101, active_work_ids: [101] });
    render(() => <HistoryView jobs={[job]} sort="usage" onSortChange={vi.fn()} onSelect={vi.fn()} onDeleted={vi.fn()} />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByRole("button", { name: "Great Song", exact: true })).toBeVisible();
    const date = within(item).getByText((_, element) => element?.tagName === "TIME");
    expect(date).toHaveAttribute("datetime", new Date(job.created_at * 1000).toISOString());
    expect(date.textContent?.trim()).not.toBe("");
    expect(item.textContent?.replace(/\s+/g, "")).toBe(`Great Song${date.textContent?.trim()}`.replace(/\s+/g, ""));
    expect(within(item).getAllByRole("button")).toHaveLength(1);
  });
  it("keeps lyrics out of the compact history summary", () => {
    render(() => <HistoryView jobs={[urlJob({ availability: { audio: true, karaoke: false, lyrics: true, pitched_lyrics: false } })]}
      sort="usage" onSortChange={vi.fn()} onSelect={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.queryByText("A long lyric that belongs in the expanded result")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Lyrics transcript" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Great Song", exact: true })).toBeVisible();
  });

  it("loads empty transcript details from the physical lyrics work after opening a song", async () => {
    const song = urlJob({ availability: { audio: true, karaoke: false, lyrics: true, pitched_lyrics: false } });
    const lyricsWork = { id: 207, result_revision: "lyrics-r1", transcript: {
      status: "empty", language: null, timestamp_reference: "original", segments: [],
      sections: [{ start_s: 0, end_s: 2, label: "chorus" }], structure_model: "SongFormer",
      presentation_lines: [], timestamped_text: "[00:00]\n[Chorus]\n",
    } } as JobDTO;
    vi.mocked(getJob).mockResolvedValueOnce(lyricsWork);
    const [selected, setSelected] = createSignal<SongSummary | null>(null);
    render(() => <>
      <Show when={selected()}>{item => <ResultsView detail={{ summary: item(), variants: [{
        pitch_semitones: 0, tempo_percent: 100, outputs: [], karaoke_work_id: null, karaoke_revision: null,
        lyrics_work_id: 207, lyrics_revision: "lyrics-r1", pitched_lyrics_work_id: null, pitched_lyrics_revision: null,
      }] }} onReset={() => setSelected(null)} refreshToken={0} onStaleDetail={vi.fn()} />}</Show>
      <HistoryView jobs={[song]} sort="usage" onSortChange={vi.fn()} onSelect={setSelected} onDeleted={vi.fn()} />
    </>);
    await userEvent.click(screen.getByRole("button", { name: "Great Song", exact: true }));
    expect(await screen.findByText("No speech was recognized.")).toBeInTheDocument();
    expect(screen.getByLabelText("Lyrics transcript").querySelector("pre")).toHaveTextContent("[00:00] [Chorus]");
    expect(screen.getByRole("link", { name: "Download timestamped TXT" })).toHaveAttribute("href", "/api/jobs/207/lyrics/download?revision=lyrics-r1");
  });


});
describe("HistoryView deletion", () => {
  it("cancel leaves the job untouched and does not select it", async () => {
    const onSelect = vi.fn();
    render(() => <HistoryView jobs={[urlJob()]} sort="usage" onSortChange={vi.fn()} onSelect={onSelect} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Great Song" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/permanently deletes this track's history/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteSong).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("Great Song")).toBeVisible();
  });

  it("confirms once, removes only the target job, and exposes retryable errors", async () => {
    const deletion = vi.mocked(deleteSong);
    const onDeleted = vi.fn();
    const [jobs, setJobs] = createSignal([urlJob(), urlJob({ id: 2, title: "Other Song" })]);
    deletion.mockRejectedValueOnce(new Error("Track is temporarily unavailable."));
    deletion.mockResolvedValueOnce(undefined);
    render(() => <HistoryView jobs={jobs()} sort="usage" onSortChange={vi.fn()} onSelect={vi.fn()}
      onDeleted={(id) => { onDeleted(id); setJobs((current) => current.filter((item) => item.id !== id)); }} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete Great Song" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete track" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Track is temporarily unavailable.");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete track" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Delete track" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(1));
    expect(deletion).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Other Song")).toBeVisible();
    expect(screen.queryByText("Great Song")).not.toBeInTheDocument();
  });
  it("preserves non-playback 409 reasons and adds stop-playback guidance only for active files", async () => {
    const deletion = vi.mocked(deleteSong);
    deletion.mockRejectedValueOnce(new AuthHttpError(409, "A job file is currently in use"));
    deletion.mockRejectedValueOnce(new AuthHttpError(409, "Inference ownership is unresolved"));
    render(() => <HistoryView jobs={[urlJob()]} sort="usage" onSortChange={vi.fn()} onSelect={vi.fn()} onDeleted={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete Great Song" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete track" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A job file is currently in use. Stop playback/downloads");
    await userEvent.click(screen.getByRole("button", { name: "Delete track" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Inference ownership is unresolved");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Stop playback/downloads");
    expect(screen.getByText("Great Song")).toBeVisible();
  });
});
