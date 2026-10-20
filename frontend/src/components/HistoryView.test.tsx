import { render, screen, waitFor } from "@solidjs/testing-library";
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
      mix_female_instruments: false,
      mix_male_instruments: false,
      mix_backing_instruments: false,
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
        { label: "vocals", filename: "vocals.mp3", download_name: "Great Song - vocals - pitch+2st - tempo120pct.mp3", size_bytes: 1, duration_s: 1 },
        { label: "instruments", filename: "instruments.mp3", download_name: "Great Song - instruments - pitch+2st - tempo120pct.mp3", size_bytes: 1, duration_s: 1 },
      ],
    });
    const onSelect = vi.fn();
    render(() => <HistoryView jobs={[job]} onSelect={onSelect} onRetried={vi.fn()} />);

    const vocals = screen.getByRole("link", { name: "vocals (pitch +2 st, tempo 120%)" });
    expect(vocals).toHaveAttribute("href", "/api/jobs/1/results/vocals");
    expect(vocals).toHaveAttribute("download", "Great Song - vocals - pitch+2st - tempo120pct.mp3");
    expect(vocals).toHaveAttribute("title", "Great Song - vocals - pitch+2st - tempo120pct.mp3");
    expect(screen.getByText("C major")).toBeInTheDocument();
    expect(screen.getByText("D major")).toBeInTheDocument();
    expect(screen.getByText("+2 semitones")).toBeInTheDocument();
    expect(screen.getByText("120% of original")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "instruments (pitch +2 st, tempo 120%)" })).toBeInTheDocument();

    const original = document.querySelector<HTMLAnchorElement>('a[href="/api/jobs/1/original"]');
    expect(original).not.toBeNull();

    // Clicking a chip downloads, it must not also open the results view.
    await userEvent.click(vocals);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("omits the original chip when no original is available", () => {
    const job = urlJob({
      has_original: false,
      manifest: [{ label: "vocals", filename: "vocals.mp3", download_name: "Great Song - vocals.mp3", size_bytes: 1, duration_s: 1 }],
    });
    render(() => <HistoryView jobs={[job]} onSelect={vi.fn()} onRetried={vi.fn()} />);
    expect(document.querySelector('a[href="/api/jobs/1/original"]')).toBeNull();
    // stems still downloadable
    expect(screen.getByRole("link", { name: "vocals" })).toBeInTheDocument();
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
