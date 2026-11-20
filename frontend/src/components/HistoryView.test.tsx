import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal, Show } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, deleteJob, type JobDTO } from "~/api";
import HistoryView from "./HistoryView";
import ResultsView from "./ResultsView";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.mocked(deleteJob).mockClear();
});

vi.mock("~/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api")>()),
  deleteJob: vi.fn(),
}));

function urlJob(overrides: Partial<JobDTO> = {}): JobDTO {
  return {
    id: 1,
    status: "done",
    position: null,
    progress: { steps: [], current: null },
    source_type: "url",
    source_value: "https://example.com/song",
    title: "Great Song",
    options: {
      extract_vocals: false,
      extract_instruments: false,
      extract_lyrics: false,
      detect_pitch: false,
      extract_pitched_lyrics: false,
      mixes: [],
      decrowd: false,
      decrowd_vocals: false,
      dereverb: false,
      genders: false,
      lead_backing: false,
      drums: false,
      pitch_semitones: 0,
      tempo_percent: 100,
    },
    original_key: "C major",
    output_key: "C major",
    result_revision: null,
    manifest: [],
    transcript: null,
    error_message: null,
    created_at: 1700000000,
    has_original: true,
    has_pitch_vocals: false,
    ...overrides,
  };
}

describe("HistoryView compact sidebar", () => {
  it("shows only the title, date and delete action without conflating selection with deletion", async () => {
    const title = "A Long Song Title That Must Stay Inside Its Library Item";
    const job = urlJob({
      title,
      options: { ...urlJob().options, pitch_semitones: 2, tempo_percent: 120 },
      output_key: "D major",
      manifest: [
        { label: "song", display_name: "song", filename: "song.mp3", download_name: "song.mp3", size_bytes: 1, duration_s: 1 },
        { label: "vocals", display_name: "vocals", filename: "vocals.mp3", download_name: "vocals.mp3", size_bytes: 1, duration_s: 1 },
      ],
    });
    const [jobs, setJobs] = createSignal([job]);
    const [selectedId, setSelectedId] = createSignal<number | null>(null);
    const onSelect = vi.fn((item: JobDTO) => setSelectedId(item.id));
    const onDeleted = vi.fn((id: number) => setJobs(current => current.filter(item => item.id !== id)));
    vi.mocked(deleteJob).mockReset().mockResolvedValue(undefined);
    render(() => <HistoryView jobs={jobs()} selectedId={selectedId()} onSelect={onSelect} onDeleted={onDeleted} />);

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
    expect(deleteJob).not.toHaveBeenCalled();
    expect(within(history).getByRole("button", { name: title, exact: true })).toBeVisible();

    await userEvent.click(within(history).getByRole("button", { name: `Delete ${title}` }));
    dialog = screen.getByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete track" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(job.id));
    expect(deleteJob).toHaveBeenCalledWith(job.id);
    expect(within(history).queryByRole("listitem")).not.toBeInTheDocument();
  });
});
describe("HistoryView results", () => {
  it("marks the selected song once and moves it ahead of the other history entries", async () => {
    const first = urlJob({ id: 11, title: "First Song" });
    const second = urlJob({ id: 12, title: "Second Song" });
    const [selected, setSelected] = createSignal<number | null>(second.id);
    render(() => <HistoryView jobs={[first, second]} selectedId={selected()} onSelect={item => setSelected(item.id)}
      onDeleted={vi.fn()} />);
    const history = screen.getByRole("region", { name: "History" });
    const titles = () => within(history).getAllByRole("button").filter(button => /^(First Song|Second Song)$/.test(button.textContent ?? ""));
    expect(titles().map(button => button.textContent)).toEqual(["Second Song", "First Song"]);
    expect(titles()[0]).toHaveAttribute("aria-current", "true");
    await userEvent.click(titles()[1]);
    expect(titles().map(button => button.textContent)).toEqual(["First Song", "Second Song"]);
    expect(titles()[0]).toHaveAttribute("aria-current", "true");
    expect(titles()[1]).not.toHaveAttribute("aria-current");
  });

  it("keeps the summary compact while preserving all downloads in opened results", async () => {
    const job = urlJob({
      options: { ...urlJob().options, pitch_semitones: 2, tempo_percent: 120 },
      output_key: "D major",
      manifest: [
        { label: "song", display_name: "song", filename: "song.mp3", download_name: "Great Song - song - source-key-C-major - pitch+2st - tempo120pct.mp3", size_bytes: 1, duration_s: 0 },
        { label: "vocals", filename: "vocals.mp3", download_name: "Great Song - vocals - source-key-C-major - pitch+2st - tempo120pct.mp3", size_bytes: 1, duration_s: 1 },
        { label: "instruments", filename: "instruments.mp3", download_name: "Great Song - instruments - source-key-C-major - pitch+2st - tempo120pct.mp3", size_bytes: 1, duration_s: 1 },
      ],
    });
    const [selected, setSelected] = createSignal<JobDTO | null>(null);
    render(() => <>
      <Show when={selected()}>{item => <ResultsView job={item()} onReset={() => setSelected(null)} />}</Show>
      <HistoryView jobs={[job]} onSelect={setSelected} onDeleted={vi.fn()} />
    </>);
    const history = screen.getByRole("region", { name: "History" });
    expect(within(history).queryByRole("link")).not.toBeInTheDocument();
    await userEvent.click(within(history).getByRole("button", { name: "Great Song", exact: true }));
    expect(screen.getByRole("link", { name: "Download original" })).toBeInTheDocument();
    for (const stem of job.manifest!) {
      expect(screen.getByRole("link", { name: `Download ${stem.download_name}` })).toBeInTheDocument();
    }
    expect(screen.getAllByText("Source key: C major")).toHaveLength(3);
    expect(screen.queryByText("Source key: D major")).toBeNull();
  });

  it("selects a history track from its title and updates the result heading once", async () => {
    const [selected, setSelected] = createSignal<JobDTO | null>(null);
    const onSelect = vi.fn((item: JobDTO) => setSelected(item));
    const jobs = [urlJob({ id: 11, title: "First Song" }), urlJob({ id: 12, title: "Second Song" })];
    render(() => <>
      <Show when={selected()}>{item => <ResultsView job={item()} onReset={() => setSelected(null)} />}</Show>
      <HistoryView jobs={jobs} onSelect={onSelect} onDeleted={vi.fn()} />
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
    const job = urlJob({
      has_original: false,
      original_key: null,
      output_key: null,
      manifest: [{ label: "vocals", filename: "vocals.mp3", download_name: "Great Song - vocals.mp3", size_bytes: 1, duration_s: 1 }],
    });
    render(() => <ResultsView job={job} onReset={vi.fn()} />);
    expect(screen.queryByRole("link", { name: "Download original" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download Great Song - vocals.mp3" })).toBeInTheDocument();
    expect(screen.queryByText(/Source key:/)).toBeNull();
  });

  it("keeps queued history to its title and date without delete", () => {
    const job = urlJob({ status: "queued", manifest: null });
    render(() => <HistoryView jobs={[job]} onSelect={vi.fn()} onDeleted={vi.fn()} />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByRole("button", { name: "Great Song", exact: true })).toBeVisible();
    const date = within(item).getByText((_, element) => element?.tagName === "TIME");
    expect(date).toHaveAttribute("datetime", new Date(job.created_at * 1000).toISOString());
    expect(date.textContent?.trim()).not.toBe("");
    expect(item.textContent?.replace(/\s+/g, "")).toBe(`Great Song${date.textContent?.trim()}`.replace(/\s+/g, ""));
    expect(within(item).getAllByRole("button")).toHaveLength(1);
  });
  it("keeps lyrics out of the compact history summary", () => {
    const transcript = {
      status: "recognized" as const, language: "en", timestamp_reference: "original" as const,
      segments: [], sections: [], timestamped_text: "A long lyric that belongs in the expanded result",
    };
    render(() => <HistoryView jobs={[urlJob({ transcript, options: { ...urlJob().options, extract_lyrics: true } })]}
      onSelect={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.queryByText(transcript.timestamped_text)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Lyrics transcript" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Great Song", exact: true })).toBeVisible();
  });

  it("retains empty transcript details when a history result is opened", async () => {
    const job = urlJob({ options: { ...urlJob().options, extract_lyrics: true }, transcript: {
      status: "empty", language: null, timestamp_reference: "original", segments: [],
      sections: [{ start_s: 0, end_s: 2, label: "chorus" }], structure_model: "SongFormer",
      timestamped_text: "[00:00]\n[Chorus]\n",
    } });
    const [selected, setSelected] = createSignal<JobDTO | null>(null);
    render(() => <>
      <Show when={selected()}>{item => <ResultsView job={item()} onReset={() => setSelected(null)} />}</Show>
      <HistoryView jobs={[job]} onSelect={setSelected} onDeleted={vi.fn()} />
    </>);
    await userEvent.click(screen.getByRole("button", { name: "Great Song", exact: true }));
    expect(screen.getByText("No speech was recognized.")).toBeInTheDocument();
    expect(screen.getByLabelText("Lyrics transcript").querySelector("pre")).toHaveTextContent("[00:00] [Chorus]");
    expect(screen.getByRole("link", { name: "Download timestamped TXT" })).toBeInTheDocument();
  });

});
describe("HistoryView deletion", () => {
  it("cancel leaves the job untouched and does not select it", async () => {
    const onSelect = vi.fn();
    render(() => <HistoryView jobs={[urlJob()]} onSelect={onSelect} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Great Song" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/permanently deletes this track's history/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteJob).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("Great Song")).toBeVisible();
  });

  it("confirms once, removes only the target job, and exposes retryable errors", async () => {
    const deletion = vi.mocked(deleteJob);
    const onDeleted = vi.fn();
    const [jobs, setJobs] = createSignal([urlJob(), urlJob({ id: 2, title: "Other Song" })]);
    deletion.mockRejectedValueOnce(new Error("Track is temporarily unavailable."));
    deletion.mockResolvedValueOnce(undefined);
    render(() => <HistoryView jobs={jobs()} onSelect={vi.fn()}
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
    const deletion = vi.mocked(deleteJob);
    deletion.mockRejectedValueOnce(new AuthHttpError(409, "A job file is currently in use"));
    deletion.mockRejectedValueOnce(new AuthHttpError(409, "Inference ownership is unresolved"));
    render(() => <HistoryView jobs={[urlJob()]} onSelect={vi.fn()} onDeleted={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete Great Song" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete track" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A job file is currently in use. Stop playback/downloads");
    await userEvent.click(screen.getByRole("button", { name: "Delete track" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Inference ownership is unresolved");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Stop playback/downloads");
    expect(screen.getByText("Great Song")).toBeVisible();
  });
});
