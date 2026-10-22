import { render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { JobDTO } from "~/api";
import ResultsView from "./ResultsView";

it("shows transposition and tempo while preserving server download names and the original", () => {
  const job: JobDTO = {
    id: 1,
    status: "done",
    position: null,
    source_type: "upload",
    source_value: "song.wav",
    title: "song.wav",
    options: {
      extract_vocals: true,
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
      pitch_semitones: 2,
      tempo_percent: 120,
    },
    original_key: "C major",
    output_key: "D major",
    manifest: [{
      label: "vocals",
      filename: "vocals.mp3",
      download_name: "song - vocals - source-key-C-major - pitch+2st - tempo120pct.mp3",
      size_bytes: 1024,
      duration_s: 10,
    }],
    error_message: null,
    created_at: 1700000000,
    has_original: true,
  };
  render(() => <ResultsView job={job} onReset={vi.fn()} />);

  expect(screen.getByText("vocals (pitch +2 st, tempo 120%)")).toBeInTheDocument();
  expect(screen.getByText("Original (unchanged)")).toBeInTheDocument();

  expect(screen.getByText("C major")).toBeInTheDocument();
  expect(screen.getByText("D major")).toBeInTheDocument();
  expect(screen.getByText("Source key: C major")).toBeInTheDocument();
  expect(screen.queryByText("Source key: D major")).toBeNull();
  expect(screen.getByText("Notes (major): C · D · E · F · G · A · B")).toBeInTheDocument();
  expect(screen.getByText("Notes (major): D · E · F# · G · A · B · C#")).toBeInTheDocument();
  expect(screen.getByText("+2 semitones")).toBeInTheDocument();
  expect(screen.getByText("120% of original")).toBeInTheDocument();
  const stem = document.querySelector<HTMLAnchorElement>('a[href="/api/jobs/1/results/vocals"]')!;
  expect(stem).toHaveAttribute("download", job.manifest![0].download_name);
  expect(stem).toHaveAttribute("href", "/api/jobs/1/results/vocals");
  const original = screen.getByRole("link", { name: "Download original" });
  expect(original).toHaveAttribute("href", "/api/jobs/1/original");
  expect(original).toHaveAttribute("download", "");
});
