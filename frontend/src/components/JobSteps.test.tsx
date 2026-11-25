import { render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { JobDTO } from "~/api";
import JobSteps from "./JobSteps";
const baseJob: JobDTO = {
  id: 1, status: "queued", position: 1, source_type: "upload", source_value: "song.wav", title: "song.wav",
  original_key: null, output_key: null, result_revision: null, manifest: null, transcript: null,
  lyric_pitch_lines: null,
  error_message: null, open_count: 0, created_at: 1, has_original: true, has_pitch_vocals: false,
  options: { extract_vocals: true, extract_instruments: false, extract_lyrics: true, detect_pitch: true,
    extract_pitched_lyrics: false, mixes: [], decrowd: false, decrowd_vocals: false, dereverb: false,
    genders: false, lead_backing: false, drums: false, pitch_semitones: 0, tempo_percent: 100 },
  progress: { steps: ["source", "analysis", "wait", "metadata", "separation", "lyrics", "pitch", "export"], current: null },
};

it("shows only the planned operations and advances states from actual reported phases", () => {
  const [job, setJob] = createSignal<JobDTO>(baseJob);
  render(() => <JobSteps job={job()} />);
  const steps = screen.getByRole("list", { name: "Processing steps" });
  expect(within(steps).getByText("Separating audio: Pending")).toBeInTheDocument();
  setJob({ ...job(), status: "running", progress: { ...job().progress, current: "lyrics" } });
  expect(within(steps).getByText("Separating audio: Complete")).toBeInTheDocument();
  expect(within(steps).getByText("Transcribing and aligning lyrics: Current").closest("li")).toHaveAttribute("aria-current", "step");
  expect(within(steps).getByText("Detecting vocal pitch: Pending")).toBeInTheDocument();
  setJob({ ...job(), status: "done" });
  expect(within(steps).getAllByText(/: Complete$/)).toHaveLength(8);
});

it("does not invent model steps for a source-only plan", () => {
  const job: JobDTO = { ...baseJob, status: "running", options: { ...baseJob.options, extract_vocals: false, extract_lyrics: false, detect_pitch: false }, progress: { steps: ["source", "analysis", "export"], current: "export" } };
  render(() => <JobSteps job={job} />);
  expect(screen.queryByText(/Separating audio|Transcribing and aligning lyrics|Detecting vocal pitch/)).not.toBeInTheDocument();
  expect(screen.getByText("Preparing outputs: Current")).toBeInTheDocument();
});
