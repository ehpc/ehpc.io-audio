import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal, Show } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import type { JobDTO, LearningDocument } from "~/api";
import * as api from "~/api";
import PitchedLyricsView from "./PitchedLyricsView";
import ResultsView, { type HistoryScrollRequest } from "./ResultsView";
import HistoryView from "./HistoryView";

vi.mock("~/api", async importOriginal => {
  const actual = await importOriginal() as typeof api;
  return { ...actual, learningProgress: vi.fn(), saveLearningPreferences: vi.fn() };
});

beforeEach(() => {
  // jsdom has no native media loading; real playback is covered by browser E2E.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

const job: JobDTO = {
  id: 9, status: "done", position: null, source_type: "upload", source_value: "song.ogg", title: "song.ogg",
  progress: { steps: ["source", "analysis", "separation", "lyrics", "pitch", "export"], current: null },
  original_key: null, output_key: null, result_revision: "build-3", manifest: [], error_message: null, created_at: 1, has_original: true,
  has_pitch_vocals: false,
  lyric_pitch_lines: null,
  options: { extract_vocals: false, extract_instruments: false, extract_lyrics: false, detect_pitch: false,
    extract_pitched_lyrics: true, mixes: [], decrowd: false, decrowd_vocals: false,
    dereverb: false, genders: false, lead_backing: false, drums: false,
    pitch_semitones: 1.25, tempo_percent: 125 },
  transcript: { segments: [], sections: [], language: "en", status: "recognized", timestamp_reference: "original",
    structure_model: null, presentation_lines: [], timestamped_text: "not the pitched renderer" },
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
  expect(link).toHaveAttribute("href", "/api/jobs/9/pitched-lyrics/lead/download?revision=build-3");
  const odt = screen.getByRole("link", { name: "Download lyrics with pitches ODT" });
  expect(odt).toHaveAttribute("href", "/api/jobs/9/pitched-lyrics/lead/download?format=odt&revision=build-3");
  fireEvent.change(screen.getByRole("combobox", { name: "Pitched lyrics vocal stem" }), { target: { value: "backing" } });
  expect(text.textContent).toBe(job.pitched_lyrics![1].text);
  expect(link).toHaveAttribute("href", "/api/jobs/9/pitched-lyrics/backing/download?revision=build-3");
  expect(odt).toHaveAttribute("href", "/api/jobs/9/pitched-lyrics/backing/download?format=odt&revision=build-3");
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
  expect(screen.queryByRole("heading", { name: "Karaoke with pitches" })).toBeNull();
  expect(screen.queryByText("not the pitched renderer")).toBeNull();
  expect(document.querySelectorAll("audio")).toHaveLength(1);
});

it("also shows both legacy views when they were explicitly requested", () => {
  const combined = { ...job, options: { ...job.options, extract_lyrics: true, detect_pitch: true } };
  render(() => <ResultsView job={combined} onReset={vi.fn()} />);
  expect(screen.getByRole("region", { name: "Aligned pitch and lyric text" }).textContent).toBe(job.pitched_lyrics![0].text);
  expect(screen.getByRole("heading", { name: "Karaoke with pitches" })).toBeInTheDocument();
  expect(screen.getByLabelText("Timestamped lyrics")).toHaveTextContent("not the pitched renderer");
  expect(screen.getByRole("link", { name: "Download pitch JSON" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Download timestamped TXT" })).toBeInTheDocument();
});

it("keeps karaoke, pitched lyrics and lyrics in order as output data arrives", () => {
  const combined = { ...job, options: { ...job.options, extract_lyrics: true, detect_pitch: true } };
  const [current, setCurrent] = createSignal<JobDTO>({ ...combined, pitch: null, pitched_lyrics: null });
  render(() => <ResultsView job={current()} onReset={vi.fn()} />);
  expect(screen.getByRole("region", { name: "Lyrics transcript" })).toBeVisible();
  setCurrent({ ...combined, pitch: null });
  fireEvent.change(screen.getByRole("combobox", { name: "Pitched lyrics vocal stem" }), { target: { value: "backing" } });
  setCurrent(combined);
  const karaoke = screen.getByRole("region", { name: "Karaoke with pitches" });
  const pitched = screen.getByRole("region", { name: "Lyrics with pitches" });
  const lyrics = screen.getByRole("region", { name: "Lyrics transcript" });
  expect(karaoke.compareDocumentPosition(pitched) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(pitched.compareDocumentPosition(lyrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Pitched lyrics vocal stem" })).toHaveValue("backing");
  expect(lyrics.compareDocumentPosition(screen.getByRole("link", { name: "Download original" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it.each(["karaoke", "original"] as const)("opens a compact history entry into ordered results and stops %s audio on close", (player) => {
  const combined = { ...job, options: { ...job.options, extract_lyrics: true, detect_pitch: true } };
  const other = { ...job, id: 10, title: "Another song" };
  const [jobs, setJobs] = createSignal<JobDTO[]>([combined, other]);
  const [selected, setSelected] = createSignal<JobDTO | null>(null);
  render(() => <>
    <Show when={selected()}>{item => <ResultsView job={item()} onReset={() => setSelected(null)} />}</Show>
    <HistoryView jobs={jobs()} onSelect={setSelected} onDeleted={vi.fn()} />
  </>);
  expect(screen.queryByText("not the pitched renderer")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Aligned pitch and lyric text" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: job.title, exact: true }));
  const karaoke = screen.getByRole("region", { name: "Karaoke with pitches" });
  const pitched = screen.getByRole("region", { name: "Lyrics with pitches" });
  const lyrics = screen.getByRole("region", { name: "Lyrics transcript" });
  expect(karaoke.compareDocumentPosition(pitched) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(pitched.compareDocumentPosition(lyrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByLabelText("Timestamped lyrics")).toHaveTextContent("not the pitched renderer");
  fireEvent.change(screen.getByRole("combobox", { name: "Pitched lyrics vocal stem" }), { target: { value: "backing" } });
  setJobs([combined, { ...other, title: "Updated other song" }]);
  expect(screen.getByRole("combobox", { name: "Pitched lyrics vocal stem" })).toHaveValue("backing");
  const audio = player === "karaoke"
    ? karaoke.querySelector<HTMLAudioElement>("audio:not([hidden])")!
    : screen.getByRole("link", { name: "Download original" }).parentElement!.querySelector<HTMLAudioElement>("audio")!;
  Object.defineProperty(audio, "paused", { configurable: true, value: false });
  const pause = vi.spyOn(audio, "pause");
  fireEvent.play(audio);
  fireEvent.click(screen.getByRole("button", { name: "Start another job" }));
  expect(pause).toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Karaoke with pitches" })).not.toBeInTheDocument();
  expect(screen.queryByText("not the pitched renderer")).not.toBeInTheDocument();
});

it("scrolls a new history selection to its own karaoke, ignores metadata rerenders, and falls back without pitch", async () => {
  const first = { ...job, title: "First song", options: { ...job.options, extract_lyrics: true, detect_pitch: true } };
  const second = { ...first, id: 10, title: "Second song" };
  const plain = {
    ...job, id: 11, title: "No karaoke", pitch: null, pitched_lyrics: null, transcript: null,
    options: { ...job.options, extract_lyrics: false, detect_pitch: false, extract_pitched_lyrics: false },
  };
  const [selected, setSelected] = createSignal<JobDTO | null>(null);
  const [scrollRequest, setScrollRequest] = createSignal<HistoryScrollRequest | null>(null);
  let token = 0;
  const scrollIntoView = vi.fn();
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  try {
    render(() => <>
      <Show when={selected()}>{item => <ResultsView job={item()} onReset={() => setSelected(null)} scrollRequest={scrollRequest()} />}</Show>
      <HistoryView jobs={[first, second, plain]} onSelect={(item) => {
        setSelected(item);
        setScrollRequest({ jobId: item.id, token: ++token });
      }} onDeleted={vi.fn()} />
    </>);
    const firstTitle = screen.getByRole("button", { name: "First song", exact: true });
    const secondTitle = screen.getByRole("button", { name: "Second song", exact: true });
    fireEvent.click(firstTitle);
    fireEvent.click(secondTitle);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const secondKaraoke = screen.getByRole("region", { name: "Karaoke with pitches" });
    expect(scrollIntoView.mock.contexts[0]).toBe(secondKaraoke);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
    expect(screen.getByRole("heading", { level: 2, name: "Second song" })).toBeVisible();

    setSelected({ ...second, title: "Second song refreshed" });
    expect(screen.getByRole("heading", { level: 2, name: "Second song refreshed" })).toBeVisible();
    await Promise.resolve();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await userEvent.click(secondTitle);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(scrollIntoView.mock.contexts[1]).toBe(screen.getByRole("region", { name: "Karaoke with pitches" }));

    await userEvent.click(screen.getByRole("button", { name: "No karaoke", exact: true }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(3));
    const resultsHeading = screen.getByRole("heading", { level: 2, name: "No karaoke" });
    expect(scrollIntoView.mock.contexts[2]).toBe(resultsHeading.parentElement?.parentElement);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it("practises pitched-only lyrics and shares saved progress with the lyrics entry", async () => {
  let document: LearningDocument = {
    document_version: "same-song", saving_available: true,
    lines: [{ id: "one", text: "Silver horizon", onset_s: 1, end_s: 3, playback_end_s: null, onset_source: "acoustic" }],
    sections: [], progress: { hint_level: "full", section_id: null, line_id: "one", difficulties: {} },
  };
  vi.mocked(api.learningProgress).mockImplementation(async () => structuredClone(document));
  vi.mocked(api.saveLearningPreferences).mockImplementation(async (_id, update) => {
    const { document_version: _, ...changes } = update;
    document = { ...document, progress: { ...document.progress, ...changes } };
    return structuredClone(document);
  });
  const studied = { ...job, transcript: { ...job.transcript!, presentation_lines: [{
    text: "Silver horizon", source_kind: "segment" as const, source_index: 0, canonical_line_index: null,
    onset_s: 1, end_s: 3, onset_source: "acoustic" as const, words: [],
  }] } };
  const [current, setCurrent] = createSignal(studied);
  render(() => <ResultsView job={current()} onReset={vi.fn()} />);
  expect(screen.queryByRole("region", { name: "Lyrics transcript" })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("region", { name: "Lyrics with pitches" })).getByRole("button", { name: "Learn lyrics" }));
  const dialog = await screen.findByRole("dialog", { name: "Learn lyrics" });
  fireEvent.click(await within(dialog).findByRole("button", { name: "Practice" }));
  expect(await within(dialog).findByRole("button", { name: "Reveal word 1" })).toHaveTextContent("Sil•••");
  fireEvent.click(within(dialog).getByRole("button", { name: "Reveal word 1" }));
  expect(within(dialog).getByRole("button", { name: "Word 1: Silver" })).toBeVisible();
  const audio = dialog.querySelector("audio")!;
  const pause = vi.spyOn(audio, "pause");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close learning" }));
  await waitFor(() => expect(audio).not.toBeInTheDocument());
  expect(pause).toHaveBeenCalled();
  setCurrent({ ...studied, options: { ...studied.options, extract_lyrics: true } });
  fireEvent.click(within(screen.getByRole("region", { name: "Lyrics transcript" })).getByRole("button", { name: "Learn lyrics" }));
  expect(await screen.findByRole("button", { name: "Reveal word 1" })).toHaveTextContent("Sil•••");
});

it("keeps untimed manual practice available without original audio and closes on job change", async () => {
  const document: LearningDocument = {
    document_version: "manual", saving_available: false,
    lines: [{ id: "one", text: "Manual practice", onset_s: null, end_s: null, playback_end_s: null, onset_source: "unknown" }],
    sections: [], progress: { hint_level: "full", section_id: null, line_id: "one", difficulties: {} },
  };
  vi.mocked(api.learningProgress).mockResolvedValue(document);
  const manual: JobDTO = { ...job, has_original: false, transcript: { ...job.transcript!, presentation_lines: [{
    text: "Manual practice", source_kind: "untimed", source_index: 0, canonical_line_index: null,
    onset_s: null, end_s: null, onset_source: "unknown", words: [],
  }] } };
  const [current, setCurrent] = createSignal(manual);
  render(() => <PitchedLyricsView job={current()} />);
  fireEvent.click(screen.getByRole("button", { name: "Learn lyrics" }));
  const dialog = await screen.findByRole("dialog", { name: "Learn lyrics" });
  expect(await within(dialog).findByText(/Original audio is unavailable/)).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Practice" }));
  expect(within(dialog).getByRole("button", { name: "Reveal word 1" })).toBeVisible();
  setCurrent({ ...job, id: 10 });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Learn lyrics" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Learn lyrics" })).not.toBeInTheDocument();
});
