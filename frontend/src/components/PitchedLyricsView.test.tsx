import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, expect, it, vi } from "vitest";
import type { JobDTO } from "~/api";
import PitchedLyricsView from "./PitchedLyricsView";
import ResultsView from "./ResultsView";
import HistoryView from "./HistoryView";

beforeEach(() => {
  // jsdom has no native media loading; real playback is covered by browser E2E.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

const job: JobDTO = {
  id: 9, status: "done", position: null, source_type: "upload", source_value: "song.ogg", title: "song.ogg",
  original_key: null, output_key: null, manifest: [], error_message: null, created_at: 1, has_original: true,
  has_pitch_vocals: false,
  options: { extract_vocals: false, extract_instruments: false, extract_lyrics: false, detect_pitch: false,
    extract_pitched_lyrics: true, mixes: [], decrowd: false, decrowd_vocals: false,
    dereverb: false, genders: false, lead_backing: false, drums: false,
    pitch_semitones: 1.25, tempo_percent: 125 },
  transcript: { segments: [], sections: [], language: "en", status: "recognized", timestamp_reference: "original",
    structure_model: null, timestamped_text: "not the pitched renderer" },
  pitch: { version: 1, model: "torchcrepe/full", source_duration_s: 5, duration_s: 4, pitch_shift_semitones: 1.25,
    tempo_percent: 125, timestamp_reference: "output", pitch_reference: "output", word_alignment: null, tracks: [], words: [] },
  pitched_lyrics: [
    { label: "lead", text: "        C#4 D4  ?\n[00:02] Cœur    поёт\n<img src=x>\n", wide_characters: "" },
    { label: "backing", text: "        ?     ?\n[00:02] Cœur  поёт\n", wide_characters: "" },
  ],
};

it("uses canonical server text verbatim and switches both protected stem formats together", () => {
  render(() => <PitchedLyricsView job={job} />);
  const text = screen.getByRole("region", { name: "Aligned pitch and lyric text" });
  expect(text.textContent).toBe(job.pitched_lyrics![0].text);
  expect(text.tagName).toBe("PRE");
  expect(text).toHaveAttribute("tabindex", "0");
  expect(document.querySelector("img")).toBeNull();
  const link = screen.getByRole("link", { name: "Download lyrics with pitches TXT" });
  expect(link).toHaveAttribute("href", "/api/jobs/9/pitched-lyrics/lead/download");
  const odt = screen.getByRole("link", { name: "Download lyrics with pitches ODT" });
  expect(odt).toHaveAttribute("href", "/api/jobs/9/pitched-lyrics/lead/download?format=odt");
  fireEvent.change(screen.getByRole("combobox", { name: "Pitched lyrics vocal stem" }), { target: { value: "backing" } });
  expect(text.textContent).toBe(job.pitched_lyrics![1].text);
  expect(link).toHaveAttribute("href", "/api/jobs/9/pitched-lyrics/backing/download");
  expect(odt).toHaveAttribute("href", "/api/jobs/9/pitched-lyrics/backing/download?format=odt");
});

it("reserves server-defined wide glyph columns without splitting ordinary text into characters", () => {
  const content = "        ?  ?     ?    ?\n[00:02] e\u0301  星光  мир  𠀀\n";
  render(() => <PitchedLyricsView job={{ ...job, pitched_lyrics: [{ label: "lead", text: content, wide_characters: "光星𠀀" }] }} />);
  const text = screen.getByRole("region", { name: "Aligned pitch and lyric text" });
  expect(text.textContent).toBe(content);
  const glyphs = [...text.querySelectorAll("span")];
  expect(glyphs.map(span => span.textContent)).toEqual(["星", "光", "𠀀"]);
  expect(glyphs.every(span => span.style.width === "2ch" && span.style.display === "inline-block")).toBe(true);
  expect(text.childNodes.length).toBeLessThan(15);
});

it("shows the requested pitched output without surfacing hidden analysis as extra views or audio exports", () => {
  render(() => <ResultsView job={job} onReset={vi.fn()} />);
  expect(screen.getByRole("region", { name: "Aligned pitch and lyric text" }).textContent).toBe(job.pitched_lyrics![0].text);
  expect(screen.queryByRole("heading", { name: "Vocal pitch timeline" })).toBeNull();
  expect(screen.queryByText("not the pitched renderer")).toBeNull();
  expect([...document.querySelectorAll("audio")].map(audio => audio.getAttribute("src"))).toEqual(["/api/jobs/9/original"]);
});

it("also shows both legacy views when they were explicitly requested", () => {
  const combined = { ...job, options: { ...job.options, extract_lyrics: true, detect_pitch: true } };
  render(() => <ResultsView job={combined} onReset={vi.fn()} />);
  expect(screen.getByRole("region", { name: "Aligned pitch and lyric text" }).textContent).toBe(job.pitched_lyrics![0].text);
  expect(screen.getByRole("heading", { name: "Vocal pitch timeline" })).toBeInTheDocument();
  expect(screen.getByLabelText("Timestamped lyrics")).toHaveTextContent("not the pitched renderer");
  expect(screen.getByRole("link", { name: "Download pitch JSON" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Download timestamped TXT" })).toBeInTheDocument();
});

it("history uses the same canonical view and stem changes do not select the job card", () => {
  const select = vi.fn();
  render(() => <HistoryView jobs={[job]} onSelect={select} onRetried={vi.fn()} />);
  const text = screen.getByRole("region", { name: "Aligned pitch and lyric text" });
  expect(text.textContent).toBe(job.pitched_lyrics![0].text);
  fireEvent.click(screen.getByRole("combobox", { name: "Pitched lyrics vocal stem" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Pitched lyrics vocal stem" }), { target: { value: "backing" } });
  expect(text.textContent).toBe(job.pitched_lyrics![1].text);
  expect(select).not.toHaveBeenCalled();
});
