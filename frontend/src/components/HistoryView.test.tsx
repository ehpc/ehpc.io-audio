import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal, Show } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, deleteJob, type JobDTO } from "~/api";
import HistoryView from "./HistoryView";
import ResultsView from "./ResultsView";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

vi.mock("~/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api")>()),
  retryJob: vi.fn(),
  deleteJob: vi.fn(),
}));

function urlJob(overrides: Partial<JobDTO> = {}): JobDTO {
  return {
    id: 1,
    status: "done",
    position: null,
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
    manifest: [],
    transcript: null,
    error_message: null,
    created_at: 1700000000,
    has_original: true,
    has_pitch_vocals: false,
    ...overrides,
  };
}

describe("HistoryView copy link", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.clearAllMocks();
  });

  it("copies the URL and shows a confirmation without selecting the job", async () => {
    const onSelect = vi.fn();
    render(() => (
      <HistoryView jobs={[urlJob()]} onSelect={onSelect} onRetried={vi.fn()} onDeleted={vi.fn()} />
    ));

    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://example.com/song",
    );
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Copied!")).toBeInTheDocument());
  });

  it("shows no copy control for upload jobs", () => {
    render(() => (
      <HistoryView
        jobs={[urlJob({ source_type: "upload", source_value: "song.mp3", title: "song.mp3" })]}
        onSelect={vi.fn()}
        onRetried={vi.fn()}
        onDeleted={vi.fn()}
      />
    ));
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  });

});
describe("HistoryView results", () => {
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
      <HistoryView jobs={[job]} onSelect={setSelected} onRetried={vi.fn()} onDeleted={vi.fn()} />
    </>);
    expect(screen.getByText("3 audio outputs")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.getByText("C major")).toBeInTheDocument();
    expect(screen.getByText("D major")).toBeInTheDocument();
    expect(screen.getByText("+2 semitones")).toBeInTheDocument();
    expect(screen.getByText("120% of original")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View results" }));
    expect(screen.getByRole("link", { name: "Download original" })).toBeInTheDocument();
    for (const stem of job.manifest!) {
      expect(screen.getByRole("link", { name: `Download ${stem.download_name}` })).toBeInTheDocument();
    }
    expect(screen.getAllByText("Source key: C major")).toHaveLength(3);
    expect(screen.queryByText("Source key: D major")).toBeNull();
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

  it("renders no chips for a queued job", () => {
    render(() => (
      <HistoryView
        jobs={[urlJob({ status: "queued", manifest: null })]}
        onSelect={vi.fn()}
        onRetried={vi.fn()}
        onDeleted={vi.fn()}
      />
    ));
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });
  it("keeps lyrics out of the compact history summary", () => {
    const transcript = {
      status: "recognized" as const, language: "en", timestamp_reference: "original" as const,
      segments: [], sections: [], timestamped_text: "A long lyric that belongs in the expanded result",
    };
    render(() => <HistoryView jobs={[urlJob({ transcript, options: { ...urlJob().options, extract_lyrics: true } })]}
      onSelect={vi.fn()} onRetried={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.queryByText(transcript.timestamped_text)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Lyrics transcript" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View results" })).toBeVisible();
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
      <HistoryView jobs={[job]} onSelect={setSelected} onRetried={vi.fn()} onDeleted={vi.fn()} />
    </>);
    await userEvent.click(screen.getByRole("button", { name: "View results" }));
    expect(screen.getByText("No speech was recognized.")).toBeInTheDocument();
    expect(screen.getByLabelText("Lyrics transcript").querySelector("pre")).toHaveTextContent("[00:00] [Chorus]");
    expect(screen.getByRole("link", { name: "Download timestamped TXT" })).toBeInTheDocument();
  });

});
describe("HistoryView key analysis", () => {
  it("does not call a pending key undetermined", () => {
    render(() => (
      <HistoryView
        jobs={[urlJob({ status: "running", original_key: null, output_key: null, manifest: null })]}
        onSelect={vi.fn()}
        onRetried={vi.fn()}
        onDeleted={vi.fn()}
      />
    ));
    expect(screen.queryByText("Undetermined")).toBeNull();
    expect(screen.getAllByText("Pending")).toHaveLength(2);
  });

  it("shows undetermined only after completed analysis found no key", () => {
    render(() => (
      <HistoryView
        jobs={[urlJob({ original_key: null, output_key: null })]}
        onSelect={vi.fn()}
        onRetried={vi.fn()}
        onDeleted={vi.fn()}
      />
    ));
    expect(screen.getAllByText("Undetermined")).toHaveLength(2);
  });
});
describe("HistoryView deletion", () => {
  it("cancel leaves the job untouched and does not call the API", async () => {
    render(() => <HistoryView jobs={[urlJob()]} onSelect={vi.fn()} onRetried={vi.fn()} onDeleted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Great Song" }));
    expect(screen.getByText(/permanently deletes this track's history/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteJob).not.toHaveBeenCalled();
    expect(screen.getByText("Great Song")).toBeVisible();
  });

  it("confirms once, removes only the target job, and exposes retryable errors", async () => {
    const deletion = vi.mocked(deleteJob);
    const onDeleted = vi.fn();
    const [jobs, setJobs] = createSignal([urlJob(), urlJob({ id: 2, title: "Other Song" })]);
    deletion.mockRejectedValueOnce(new Error("Track is temporarily unavailable."));
    deletion.mockResolvedValueOnce(undefined);
    render(() => <HistoryView jobs={jobs()} onSelect={vi.fn()} onRetried={vi.fn()}
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
    render(() => <HistoryView jobs={[urlJob()]} onSelect={vi.fn()} onRetried={vi.fn()} onDeleted={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete Great Song" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete track" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A job file is currently in use. Stop playback/downloads");
    await userEvent.click(screen.getByRole("button", { name: "Delete track" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Inference ownership is unresolved");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Stop playback/downloads");
    expect(screen.getByText("Great Song")).toBeVisible();
  });
});
