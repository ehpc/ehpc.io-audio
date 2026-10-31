import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, expect, it, vi } from "vitest";
import type { JobDTO, PitchAnalysisDTO } from "~/api";
import PitchView from "./PitchView";
import TranscriptView from "./TranscriptView";

const pitch: PitchAnalysisDTO = {
  version: 1, model: "torchcrepe/full", source_duration_s: 87.5, duration_s: 70,
  pitch_shift_semitones: 1.25, tempo_percent: 125,
  timestamp_reference: "output", pitch_reference: "output", word_alignment: "whisper-approximate",
  words: [{ start_s: 1, end_s: 3, text: "world", probability: 0.9 }],
  tracks: [{ label: "vocals", notes: [
    { start_s: 1, end_s: 2, midi: 61.25, frequency_hz: 281.1, note: "C#4", cents: 25, confidence: 0.9, word_indices: [0] },
    { start_s: 2, end_s: 3, midi: 63.25, frequency_hz: 315.5, note: "D#4", cents: 25, confidence: 0.8, word_indices: [0] },
    { start_s: 59.999, end_s: 61.001, midi: 64.25, frequency_hz: 334.4, note: "E4", cents: 25, confidence: 0.85, word_indices: [] },
  ] }, { label: "backing", notes: [] }],
};
function job(): JobDTO {
  return {
    id: 7, status: "done", position: null, source_type: "upload", source_value: "voice.ogg", title: "voice.ogg",
    original_key: null, output_key: null, transcript: null, error_message: null, created_at: 1, has_original: true,
    options: { detect_pitch: true, extract_lyrics: true, extract_vocals: true, extract_instruments: false,
      mix_female_instruments: false, mix_male_instruments: false, mix_backing_instruments: false, mix_lead_instruments: false,
      decrowd: false, decrowd_vocals: false, dereverb: false, genders: false, lead_backing: false, drums: false, no_cache: false,
      pitch_semitones: 1.25, tempo_percent: 125 },
    manifest: [{ label: "vocals", filename: "vocals.mp3", download_name: "voice-vocals.mp3", duration_s: 1, size_bytes: 100 }],
    pitch,
  };
}
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

it("uses detected time/pitch geometry, linked melisma, zoom and real player seeking without inventing syllables", () => {
  render(() => <PitchView job={job()} />);
  const notes = document.querySelectorAll<SVGGElement>(".pitch-note");
  expect(notes).toHaveLength(3);
  expect(notes[0].querySelector("text")).toHaveTextContent("C#4");
  expect(notes[0].querySelector("rect")).toHaveAttribute("x", "100");
  expect(notes[0].querySelector("rect")).toHaveAttribute("width", "100");
  const lowY = Number(notes[0].querySelector("rect")!.getAttribute("y"));
  const highY = Number(notes[1].querySelector("rect")!.getAttribute("y"));
  expect(lowY - highY).toBe(48);
  fireEvent.click(notes[0]);
  const audio = document.querySelector("audio")!;
  expect(audio.getAttribute("src")).toBe("/api/jobs/7/results/vocals");
  expect(audio.currentTime).toBe(1);
  expect(document.querySelector(".pitch-selection")).toHaveTextContent("+25 cents");
  fireEvent.click(screen.getByRole("button", { name: "world, approximate word timing; 2 linked notes" }));
  expect(document.querySelectorAll(".pitch-note-selected")).toHaveLength(2);
  expect(document.querySelector(".pitch-selection")).toHaveTextContent("2 linked notes");
  expect(document.querySelector(".pitch-selection")).not.toHaveTextContent("Select a note");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in melody" }));
  expect(notes[0].querySelector("rect")).toHaveAttribute("x", "120");
  expect(notes[0].querySelector("rect")).toHaveAttribute("width", "120");
  fireEvent.input(screen.getByRole("slider", { name: "Melody zoom" }), { target: { value: "640" } });
  expect(notes[0].querySelector("rect")).toHaveAttribute("x", "640");
  expect(screen.getByText("0:11.75", { exact: true })).toHaveStyle({ left: "7574px" });
  expect(screen.getByText(/not exact syllable timing/)).toBeInTheDocument();
});

it("maps original reference playback to output time and shows honest empty-stem transitions", () => {
  const source = job();
  source.manifest = [];
  render(() => <PitchView job={source} />);
  const audio = document.querySelector("audio")!;
  fireEvent.click(document.querySelector(".pitch-note")!);
  expect(audio.currentTime).toBe(1.25);
  audio.currentTime = 5;
  fireEvent.timeUpdate(audio);
  expect(document.querySelector(".pitch-playhead")).toHaveAttribute("x1", "400");
  expect(screen.getByText("Original full song (unchanged, not isolated vocals)")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Pitch vocal stem"), { target: { value: "backing" } });
  expect(document.querySelectorAll(".pitch-note")).toHaveLength(0);
  expect(screen.getByRole("status")).toHaveTextContent("No confident voiced notes detected");
  expect(document.querySelector(".pitch-selection")).toHaveTextContent("Select a note");
});

it("rounds the entire timestamp at the minute rollover rather than displaying impossible 0:60.00", () => {
  render(() => <PitchView job={job()} />);
  const boundary = screen.getByRole("button", { name: /E4, \+25 cents; 1:00.00–1:01.00/ });
  fireEvent.click(boundary);
  expect(document.querySelector(".pitch-selection")).toHaveTextContent("1:00.00–1:01.00");
  expect(document.querySelector(".pitch-selection")).not.toHaveTextContent("0:60.00");
});

it("keeps corrected text separate from original ASR provenance and its downloadable canonical JSON", () => {
  const source = job();
  source.transcript = {
    status: "recognized", language: "en", timestamp_reference: "original", sections: [], structure_model: null,
    segments: [{ start_s: 1, end_s: 2, text: "Good morning" }],
    timestamped_text: "[00:01] Good morning\n", original_timestamped_text: "[00:01] Good morninx\n",
    reference: { status: "corrected", reason: "Tentative spelling correction.", provider: "LRCLIB",
      source_url: "https://lrclib.net/api/get/123", record_id: 123, artist: "Artist", title: "Track", album: null,
      duration_s: 4, agreement: 0.98,
      corrections: [{ word_index: 1, original: "morninx", replacement: "morning", start_s: 1.5, end_s: 2 }],
      original_segments: [{ start_s: 1, end_s: 2, text: "Good morninx" }],
      original_words: [{ start_s: 1.5, end_s: 2, text: "morninx", probability: 0.3 }] },
  };
  render(() => <TranscriptView job={source} />);
  expect(screen.getByText("[00:01] Good morning")).toBeVisible();
  expect(screen.getByText("[00:01] Good morninx")).not.toBeVisible();
  fireEvent.click(screen.getByText("Original ASR (before reference comparison)"));
  expect(screen.getByText("[00:01] Good morninx")).toBeVisible();
  expect(screen.getByRole("link", { name: "LRCLIB source: Artist — Track" })).toHaveAttribute("href", "https://lrclib.net/api/get/123");
  expect(screen.getByRole("link", { name: "Download lyrics JSON + original ASR" })).toHaveAttribute("href", "/api/jobs/7/lyrics/download.json");
  expect(screen.getByText(/“morninx” → “morning”/)).toHaveTextContent("1.50s on original audio");
});
