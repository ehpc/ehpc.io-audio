import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDTO } from "~/api";
import HistoryView from "./HistoryView";

vi.mock("~/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api")>()),
  retryJob: vi.fn(),
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
      mix_female_instruments: false,
      mix_male_instruments: false,
      mix_backing_instruments: false,
      mix_lead_instruments: false,
      decrowd: false,
      decrowd_vocals: false,
      dereverb: false,
      genders: false,
      lead_backing: false,
      drums: false,
      no_cache: false,
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
      <HistoryView jobs={[urlJob()]} onSelect={onSelect} onRetried={vi.fn()} />
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
      />
    ));
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  });
});

describe("HistoryView download chips", () => {
  it("renders a download link per stem for done jobs", async () => {
    const job = urlJob({
      options: { ...urlJob().options, pitch_semitones: 2, tempo_percent: 120 },
      output_key: "D major",
      manifest: [
        { label: "song", filename: "song.mp3", download_name: "Great Song - song - source-key-C-major - pitch+2st - tempo120pct.mp3", size_bytes: 1, duration_s: 0 },
        { label: "vocals", filename: "vocals.mp3", download_name: "Great Song - vocals - source-key-C-major - pitch+2st - tempo120pct.mp3", size_bytes: 1, duration_s: 1 },
        { label: "instruments", filename: "instruments.mp3", download_name: "Great Song - instruments - source-key-C-major - pitch+2st - tempo120pct.mp3", size_bytes: 1, duration_s: 1 },
      ],
    });
    const onSelect = vi.fn();
    render(() => <HistoryView jobs={[job]} onSelect={onSelect} onRetried={vi.fn()} />);

    const vocals = screen.getByRole("link", { name: "vocals (pitch +2 st, tempo 120%) Source key: C major" });
    expect(vocals).toHaveAttribute("href", "/api/jobs/1/results/vocals");
    expect(vocals).toHaveAttribute("download", "Great Song - vocals - source-key-C-major - pitch+2st - tempo120pct.mp3");
    expect(vocals).toHaveAttribute("title", "Great Song - vocals - source-key-C-major - pitch+2st - tempo120pct.mp3");
    expect(screen.getByText("C major")).toBeInTheDocument();
    expect(screen.getByText("D major")).toBeInTheDocument();
    expect(screen.getByText("+2 semitones")).toBeInTheDocument();
    expect(screen.getByText("120% of original")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "instruments (pitch +2 st, tempo 120%) Source key: C major" })).toBeInTheDocument();
    expect(screen.getAllByText("Source key: C major")).toHaveLength(3);
    const song = screen.getByRole("link", { name: "Full song (pitch +2 st, tempo 120%) Source key: C major" });
    expect(song).toHaveAttribute("href", "/api/jobs/1/results/song");
    expect(song).toHaveAttribute("download", job.manifest![0].download_name);
    expect([...document.querySelectorAll('a[download]')].map(link => link.getAttribute("href"))).toEqual([
      "/api/jobs/1/original", "/api/jobs/1/results/song", "/api/jobs/1/results/vocals", "/api/jobs/1/results/instruments",
    ]);
    expect(screen.queryByText("Source key: D major")).toBeNull();

    const original = document.querySelector<HTMLAnchorElement>('a[href="/api/jobs/1/original"]');
    expect(original).not.toBeNull();

    // Clicking a chip downloads, it must not also open the results view.
    vocals.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(vocals);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("omits the original chip when no original is available", () => {
    const job = urlJob({
      has_original: false,
      original_key: null,
      output_key: null,
      manifest: [{ label: "vocals", filename: "vocals.mp3", download_name: "Great Song - vocals.mp3", size_bytes: 1, duration_s: 1 }],
    });
    render(() => <HistoryView jobs={[job]} onSelect={vi.fn()} onRetried={vi.fn()} />);
    expect(document.querySelector('a[href="/api/jobs/1/original"]')).toBeNull();
    // stems still downloadable
    expect(screen.getByRole("link", { name: "vocals" })).toBeInTheDocument();
    expect(screen.queryByText(/Source key:/)).toBeNull();
  });

  it("renders no chips for a queued job", () => {
    render(() => (
      <HistoryView
        jobs={[urlJob({ status: "queued", manifest: null })]}
        onSelect={vi.fn()}
        onRetried={vi.fn()}
      />
    ));
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("shows timestamped lyrics and the protected TXT link without selecting the history row", async () => {
    const transcript = {
      status: "recognized" as const,
      language: "en",
      timestamp_reference: "original" as const,
      segments: [{ start_s: 0, end_s: 1, text: "My fellow Americans" }],
      sections: [{ start_s: 0, end_s: 1, label: "chorus" as const }],
      structure_model: "SongFormer",
      timestamped_text: "[00:00]\n[Chorus]\n[00:00] My fellow Americans",
    };
    const onSelect = vi.fn();
    render(() => (
      <HistoryView
        jobs={[urlJob({ transcript })]}
        onSelect={onSelect}
        onRetried={vi.fn()}
      />
    ));
    const transcriptView = screen.getByLabelText("Lyrics transcript");
    expect(transcriptView.querySelector("pre")).not.toBeVisible();
    const reveal = within(transcriptView).getByText("View lyrics");
    await userEvent.click(reveal);
    expect(transcriptView.querySelector("pre")).toHaveTextContent("[00:00] [Chorus] [00:00] My fellow Americans");
    expect(screen.getByText(/section labels are automatic estimates/)).toBeInTheDocument();
    expect(screen.getByText(/Original audio timestamps/)).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    const download = screen.getByRole("link", { name: "Download timestamped TXT" });
    expect(download).toHaveAttribute("href", "/api/jobs/1/lyrics/download");
    expect(download).toHaveAttribute("download", "");
    download.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(download);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows an explicit empty-transcript message and still links the TXT", async () => {
    render(() => (
      <HistoryView
        jobs={[urlJob({ transcript: {
          status: "empty",
          language: null,
          timestamp_reference: "original",
          segments: [],
          sections: [{ start_s: 0, end_s: 2, label: "chorus" }],
          structure_model: "SongFormer",
          timestamped_text: "[00:00]\n[Chorus]\n",
        } })]}
        onSelect={vi.fn()}
        onRetried={vi.fn()}
      />
    ));
    await userEvent.click(screen.getByText("View lyrics"));
    expect(screen.getByText("No speech was recognized.")).toBeInTheDocument();
    expect(screen.getByLabelText("Lyrics transcript").querySelector("pre"))
      .toHaveTextContent("[00:00] [Chorus]");
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
      />
    ));
    expect(screen.getAllByText("Undetermined")).toHaveLength(2);
  });
});
