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
      extract_lyrics: false,
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
      pitch_semitones: 2,
      tempo_percent: 120,
    },
    original_key: "C major",
    output_key: "D major",
    manifest: [{
      label: "song",
      filename: "song - pitch+2st - tempo120pct.mp3",
      download_name: "song - song - source-key-C-major - pitch+2st - tempo120pct.mp3",
      size_bytes: 2048,
      duration_s: 0,
    }, {
      label: "vocals",
      filename: "vocals.mp3",
      download_name: "song - vocals - source-key-C-major - pitch+2st - tempo120pct.mp3",
      size_bytes: 1024,
      duration_s: 10,
    }],
    transcript: {
      status: "recognized",
      language: "en",
      timestamp_reference: "original",
      segments: [{ start_s: 0, end_s: 2.5, text: "<img src=x onerror=alert(1)>" }],
      sections: [],
      structure_model: null,
      timestamped_text: "[00:00] <img src=x onerror=alert(1)>",
    },
    error_message: null,
    created_at: 1700000000,
    has_original: true,
  };
  render(() => <ResultsView job={job} onReset={vi.fn()} />);

  expect(screen.getByText("vocals (pitch +2 st, tempo 120%)")).toBeInTheDocument();
  expect(screen.getByText("Original (unchanged)")).toBeInTheDocument();

  expect(screen.getByText("C major")).toBeInTheDocument();
  expect(screen.getByText("D major")).toBeInTheDocument();
  expect(screen.getAllByText("Source key: C major")).toHaveLength(2);
  expect(screen.queryByText("Source key: D major")).toBeNull();
  expect(screen.getByText("Notes (major): C · D · E · F · G · A · B")).toBeInTheDocument();
  expect(screen.getByText("Notes (major): D · E · F# · G · A · B · C#")).toBeInTheDocument();
  expect(screen.getByText("+2 semitones")).toBeInTheDocument();
  expect(screen.getByText("120% of original")).toBeInTheDocument();
  const stem = document.querySelector<HTMLAnchorElement>('a[href="/api/jobs/1/results/vocals"]')!;
  expect(stem).toHaveAttribute("download", job.manifest![1].download_name);
  expect(stem).toHaveAttribute("href", "/api/jobs/1/results/vocals");
  const original = screen.getByRole("link", { name: "Download original" });
  expect(original).toHaveAttribute("href", "/api/jobs/1/original");
  expect(original).toHaveAttribute("download", "");
  expect(screen.getByText("Full song (pitch +2 st, tempo 120%)")).toBeInTheDocument();
  expect([...document.querySelectorAll("audio")].map(audio => audio.getAttribute("src"))).toEqual([
    "/api/jobs/1/original", "/api/jobs/1/results/song", "/api/jobs/1/results/vocals",
  ]);
  expect(document.querySelector('a[href="/api/jobs/1/results/song"]')).toHaveAttribute(
    "download", job.manifest![0].download_name,
  );
  expect(screen.getByText("Original audio timestamps · approximate segment timing. Automatic transcription may contain errors; review the text.")).toBeInTheDocument();
  expect(screen.getByText("Language: en")).toBeInTheDocument();
  expect(screen.getByText("[00:00] <img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  const lyrics = screen.getByRole("link", { name: "Download timestamped TXT" });
  expect(lyrics).toHaveAttribute("href", "/api/jobs/1/lyrics/download");
  expect(lyrics).toHaveAttribute("download", "");
});
