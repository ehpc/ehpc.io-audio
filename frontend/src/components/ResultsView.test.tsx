import { render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { JobDTO } from "~/api";
import ResultsView from "./ResultsView";

it("keeps stem keys tied to the source and renders lyric markup as text", () => {
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
      extract_lyrics: true,
      detect_pitch: false,
      extract_pitched_lyrics: false,
      mixes: [],
      decrowd: false,
      decrowd_vocals: false,
      dereverb: false,
      genders: false,
      lead_backing: false,
      drums: false,
      tempo_percent: 120,
      pitch_semitones: 2,
    },
    original_key: "C major",
    output_key: "D major",
    manifest: [{
      label: "song",
      display_name: "song",
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
    has_pitch_vocals: false,
  };
  render(() => <ResultsView job={job} onReset={vi.fn()} />);

  expect(screen.getByText("C major")).toBeInTheDocument();
  expect(screen.getByText("D major")).toBeInTheDocument();
  expect(screen.getAllByText("Source key: C major")).toHaveLength(2);
  expect(screen.queryByText("Source key: D major")).toBeNull();
  expect(screen.getByText("[00:00] <img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
});

