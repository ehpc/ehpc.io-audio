import { fireEvent, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
    has_pitch_vocals: true,
    options: { detect_pitch: true, extract_lyrics: true, extract_vocals: true, extract_instruments: false,
      extract_pitched_lyrics: false,
      mixes: [],
      decrowd: false, decrowd_vocals: false, dereverb: false, genders: false, lead_backing: false, drums: false,
      pitch_semitones: 1.25, tempo_percent: 125 },
    manifest: [{ label: "vocals", filename: "vocals.mp3", download_name: "voice-vocals.mp3", duration_s: 1, size_bytes: 100 }],
    pitch,
  };
}
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function scrollPlayer(source = job()) {
  const rendered = render(() => <PitchView job={source} />);
  const audio = document.querySelector<HTMLAudioElement>("audio")!;
  const viewport = screen.getByRole("region", { name: "Scrollable vocal melody timeline" });
  const state = { paused: false };
  Object.defineProperties(audio, {
    paused: { configurable: true, get: () => state.paused },
    readyState: { configurable: true, value: 4 },
  });
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 300 },
    clientHeight: { configurable: true, value: 240 },
    scrollWidth: { configurable: true, value: 50_000 },
    scrollHeight: { configurable: true, value: 1000 },
    onscrollend: { configurable: true, value: null },
  });
  fireEvent.input(screen.getByRole("slider", { name: "Melody zoom" }), { target: { value: "100" } });
  const time = (seconds: number) => { audio.currentTime = seconds; fireEvent.timeUpdate(audio); };
  const scroll = (left: number, top = viewport.scrollTop) => {
    viewport.scrollLeft = left;
    viewport.scrollTop = top;
    fireEvent.scroll(viewport);
  };
  const wheel = (left: number, top = viewport.scrollTop) => {
    fireEvent.wheel(viewport, { deltaX: left - viewport.scrollLeft, deltaY: top - viewport.scrollTop });
    scroll(left, top);
  };
  const end = () => fireEvent(viewport, new Event("scrollend", { bubbles: true }));
  const browsing = () => Boolean(document.querySelector(".pitch-follow-status")?.textContent?.trim());
  return { ...rendered, audio, viewport, state, time, scroll, wheel, end, browsing };
}

function animationFrames() {
  let next = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
  return () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(0);
  };
}

function keyboardPlayer(source = job()) {
  const player = scrollPlayer(source);
  player.state.paused = true;
  const play = vi.spyOn(player.audio, "play").mockImplementation(() => {
    player.state.paused = false;
    fireEvent.play(player.audio);
    return Promise.resolve();
  });
  vi.spyOn(player.audio, "pause").mockImplementation(() => {
    player.state.paused = true;
    fireEvent.pause(player.audio);
  });
  return { ...player, play };
}

it.each(["viewport", "ruler"])("toggles native playback with focused %s Space without repeating or arming browsing", targetName => {
  const frame = animationFrames();
  const player = keyboardPlayer();
  const target = targetName === "viewport" ? player.viewport : screen.getByRole("slider", { name: "Pitch timeline position" });
  fireEvent.keyDown(target, { key: " " });
  expect(player.audio.paused).toBe(false);
  fireEvent.keyDown(target, { key: " ", repeat: true });
  expect(player.audio.paused).toBe(false);
  player.audio.currentTime = 5;
  frame();
  expect(player.viewport.scrollLeft).toBeGreaterThan(0);
  fireEvent.keyUp(target, { key: " " });
  fireEvent.keyDown(target, { key: " " });
  expect(player.audio.paused).toBe(true);
  player.audio.currentTime = 6;
  frame();
  expect(screen.getByRole("slider", { name: "Pitch timeline position" })).toHaveAttribute("aria-valuenow", "5");
});

it("keeps a browsed view fixed when Space restarts and pauses playback", () => {
  const frame = animationFrames();
  const player = keyboardPlayer();
  player.time(5);
  player.wheel(3000);
  player.end();
  fireEvent.keyDown(player.viewport, { key: " " });
  expect(player.audio.paused).toBe(false);
  player.audio.currentTime = 9;
  frame();
  expect(player.viewport.scrollLeft).toBe(3000);
  fireEvent.keyUp(player.viewport, { key: " " });
  fireEvent.keyDown(player.viewport, { key: " " });
  expect(player.audio.paused).toBe(true);
  expect(player.viewport.scrollLeft).toBe(3000);
});

it("leaves note/word Space activation and composing or modified Space to their existing owners", async () => {
  const player = keyboardPlayer();
  for (const target of [player.viewport, screen.getByRole("slider", { name: "Pitch timeline position" })]) {
    for (const modifier of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, ...modifier });
      fireEvent(target, event);
      expect(player.audio.paused).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
  }
  const note = document.querySelectorAll<SVGGElement>(".pitch-note")[1];
  fireEvent.keyDown(note, { key: " " });
  expect(player.audio.currentTime).toBe(2);
  expect(player.audio.paused).toBe(true);
  expect(document.querySelector(".pitch-selection")).toHaveTextContent("D#4");
  const word = screen.getByRole("button", { name: /^world,/ });
  word.focus();
  await userEvent.keyboard("[Space]");
  expect(player.audio.currentTime).toBe(1);
  expect(player.audio.paused).toBe(true);
  expect(document.querySelector(".pitch-selection")).toHaveTextContent("world");
});

it.each(["keyboard pause", "external pause", "restart", "source change"])("does not report interrupted pending playback after %s", async interruption => {
  const player = keyboardPlayer();
  const pending = Promise.withResolvers<void>();
  player.play.mockImplementationOnce(() => { player.state.paused = false; fireEvent.play(player.audio); return pending.promise; });
  vi.spyOn(player.audio, "load").mockImplementation(() => { player.state.paused = true; fireEvent.emptied(player.audio); });
  fireEvent.keyDown(player.viewport, { key: " " });
  expect(player.audio.paused).toBe(false);
  if (interruption === "keyboard pause" || interruption === "restart") {
    fireEvent.keyUp(player.viewport, { key: " " });
    fireEvent.keyDown(player.viewport, { key: " " });
    if (interruption === "restart") {
      fireEvent.keyUp(player.viewport, { key: " " });
      fireEvent.keyDown(player.viewport, { key: " " });
    }
  } else if (interruption === "external pause") player.audio.pause();
  else fireEvent.change(screen.getByLabelText("Pitch background audio"), { target: { value: "song" } });
  pending.reject(new DOMException("The old playback attempt ended.", interruption === "source change" ? "NotSupportedError" : "AbortError"));
  await pending.promise.catch(() => {});
  expect(player.audio.paused).toBe(interruption !== "restart");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each(["NotAllowedError", "NotSupportedError"])("shows a current %s until playback actually restarts", async name => {
  const player = keyboardPlayer();
  const message = `Media refused playback: ${name}`;
  player.play.mockRejectedValueOnce(new DOMException(message, name));
  fireEvent.keyDown(player.viewport, { key: " " });
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(player.audio.paused).toBe(true);
  fireEvent.loadedMetadata(player.audio);
  expect(screen.getByRole("alert")).toBeVisible();
  fireEvent.keyUp(player.viewport, { key: " " });
  fireEvent.keyDown(player.viewport, { key: " " });
  expect(player.audio.paused).toBe(false);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps the transport action synchronized with native playback, external pause, ending and source changes", async () => {
  const player = keyboardPlayer();
  fireEvent.click(screen.getByRole("button", { name: "Play", exact: true }));
  expect(player.audio.paused).toBe(false);
  expect(screen.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  player.audio.pause();
  const playButton = screen.getByRole("button", { name: "Play", exact: true });
  playButton.focus();
  await userEvent.keyboard("[Space]");
  expect(player.audio.paused).toBe(false);
  const pauseButton = screen.getByRole("button", { name: "Pause", exact: true });
  pauseButton.focus();
  await userEvent.keyboard("[Enter]");
  expect(player.audio.paused).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Play", exact: true }));
  Object.defineProperty(player.audio, "ended", { configurable: true, value: true });
  fireEvent.ended(player.audio);
  expect(screen.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  Object.defineProperty(player.audio, "ended", { configurable: true, value: false });
  player.audio.pause();
  fireEvent.click(screen.getByRole("button", { name: "Play", exact: true }));
  vi.spyOn(player.audio, "load").mockImplementation(() => { player.state.paused = true; fireEvent.emptied(player.audio); });
  fireEvent.change(screen.getByLabelText("Pitch background audio"), { target: { value: "song" } });
  expect(player.audio.paused).toBe(true);
  expect(screen.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
});

it("does not advertise pause before native playback starts and exposes a rejected button play", async () => {
  const player = keyboardPlayer();
  const pending = Promise.withResolvers<void>();
  player.play.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Play", exact: true }));
  expect(player.audio.paused).toBe(true);
  expect(screen.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  pending.reject(new DOMException("Permission denied by the media device.", "NotAllowedError"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied by the media device.");
  fireEvent.click(screen.getByRole("button", { name: "Play", exact: true }));
  expect(player.audio.paused).toBe(false);
  expect(screen.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("disables playback when neither original nor a listening reference exists", () => {
  const source = job();
  source.has_original = false;
  source.has_pitch_vocals = false;
  source.manifest = [];
  render(() => <PitchView job={source} />);
  expect(screen.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
});

it("preserves numeric lyrics without appended counts while selecting every associated note", () => {
  const source = job();
  source.pitch = { ...pitch, words: [{ ...pitch.words[0], start_s: 0.75, text: "99" }] };
  render(() => <PitchView job={source} />);
  const word = screen.getByRole("button", { name: /^99,/ });
  expect(word).toHaveTextContent(/^99$/);
  expect(word.getAttribute("aria-label")?.match(/\d+/g)).toEqual(["99"]);
  fireEvent.click(word);
  expect(document.querySelector("audio")!.currentTime).toBe(1);
  expect(document.querySelectorAll(".pitch-note-selected")).toHaveLength(2);
  expect(document.querySelector(".pitch-selection")!.textContent?.match(/\d+/g)).toEqual(["99"]);
  expect(screen.getByRole("tooltip")).toHaveTextContent(/^99$/);
});

it.each(["instruments", "drums"])("plays a generated %s background on the output clock without changing the analyzed voice", label => {
  const source = job();
  source.manifest!.push({ label, filename: `${label}.mp3`, download_name: `${label}.mp3`, duration_s: 70, size_bytes: 100 });
  const player = keyboardPlayer(source);
  vi.spyOn(player.audio, "load").mockImplementation(() => { player.state.paused = true; fireEvent.emptied(player.audio); });
  const backgrounds = screen.getByRole("combobox", { name: "Pitch background audio" });
  fireEvent.change(backgrounds, { target: { value: "song" } });
  player.audio.volume = 0.4;
  player.time(12.5);
  fireEvent.click(screen.getByRole("button", { name: "Play", exact: true }));
  fireEvent.change(backgrounds, { target: { value: label } });
  fireEvent.loadedMetadata(player.audio);
  expect(player.audio.currentTime).toBe(10);
  expect(player.audio.paused).toBe(true);
  expect(player.audio.volume).toBe(0.4);
  expect(screen.getByLabelText("Pitch vocal stem")).toHaveValue("vocals");
  fireEvent.click(screen.getByRole("button", { name: "Forward 5 seconds", exact: true }));
  expect(player.audio.currentTime).toBe(15);
  fireEvent.change(backgrounds, { target: { value: "song" } });
  fireEvent.loadedMetadata(player.audio);
  expect(player.audio.currentTime).toBe(18.75);
  expect(player.audio.paused).toBe(true);
});

it("does not offer absent accompaniment bytes just because processing flags or a cleaned instrumental exist", () => {
  const source = job();
  source.options.extract_instruments = true;
  source.options.drums = true;
  source.manifest!.push({ label: "instruments-decrowded", filename: "cleaned.mp3", download_name: "cleaned.mp3", duration_s: 70, size_bytes: 100 });
  render(() => <PitchView job={source} />);
  const backgrounds = screen.getByRole("combobox", { name: "Pitch background audio" });
  expect(backgrounds.querySelector('option[value="instruments"]')).toBeDisabled();
  expect(backgrounds.querySelector('option[value="drums"]')).toBeDisabled();
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
  expect(audio.currentTime).toBe(1);
  expect(document.querySelector(".pitch-selection")).toHaveTextContent("+25 cents");
  fireEvent.click(screen.getByRole("button", { name: /^world,/ }));
  expect(document.querySelectorAll(".pitch-note-selected")).toHaveLength(2);
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
  source.has_pitch_vocals = false;
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
  expect(document.querySelector(".pitch-view > [role=status]")).toHaveTextContent("No confident voiced notes detected");
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

it("shows ordered reference support, unsupported words, conflicting variants and raw untimed recognition without implying verification", () => {
  const source = job();
  source.transcript = {
    status: "recognized", language: "English", timestamp_reference: "original", sections: [], structure_model: null,
    asr_model: "Qwen/Qwen3-ASR-1.7B", word_alignment: "torchaudio/MMS_FA",
    segments: [{ start_s: 31, end_s: 34, text: "Amber lanterns softly shine" }],
    words: [{ start_s: 31, end_s: 32, text: "Amber", probability: null, alignment_score: 0.7 }],
    timestamped_text: "[00:31] Amber lanterns softly shine\n[??:??] Silver branches sway\n",
    original_timestamped_text: "[00:31] Amber lanterns shine\n",
    recognition_chunks: [{ input_start_s: 20, input_end_s: 47, ownership_start_s: 21, ownership_end_s: 46,
      text: "Amber lanterns shine! <img src=x onerror=alert(1)>", language: "English" }],
    reference: {
      status: "partial", reason: "One line reference-aligned; another conflicts.", provider: "LRCLIB",
      source_url: "https://lrclib.net/api/get/123", record_id: 123, artist: "Artist", title: "Track", album: null,
      duration_s: 90, agreement: 0.7, fetched_at: "2026-10-31T12:00:00+00:00", cached: true,
      corrections: [], original_segments: [{ start_s: 31, end_s: 34, text: "Amber lanterns shine" }], original_words: [],
      lines: [
        { text: "Amber lanterns softly shine", status: "aligned", support: 0.75, start_s: 31, end_s: 34,
          unconfirmed_words: ["softly"], recognized_variant: null, reason: "Reference-aligned, not verified." },
        { text: "Silver branches sway", status: "unconfirmed", support: 0.67, start_s: null, end_s: null,
          unconfirmed_words: ["sway"], recognized_variant: "silver branches sleep", reason: "Conflicting variant retained." },
      ],
    },
  };
  render(() => <TranscriptView job={source} />);
  fireEvent.click(screen.getByText("Canonical reference order and audio support"));
  const lines = document.querySelectorAll("ol > li");
  expect(lines[0]).toHaveTextContent("Amber lanterns softly shine");
  expect(lines[1]).toHaveTextContent("Silver branches sway");
  expect(lines[1]).toHaveTextContent("??:??");
  expect(lines[1]).not.toHaveTextContent("nulls");
  expect(lines[0]).toHaveTextContent("Not independently corroborated; no word timestamps: softly");
  expect(lines[1]).toHaveTextContent("Independent recognition variant (preserved): silver branches sleep");
  expect(screen.getByText(/Cached successful provider record/)).toBeVisible();
  fireEvent.click(screen.getByText("Raw independent recognition (input windows, not lyric timestamps)"));
  expect(screen.getByText("Amber lanterns shine! <img src=x onerror=alert(1)>")).toBeVisible();
  expect(document.querySelector("img")).toBeNull();
});

it("retains unversioned word timing interactions without inventing a recognizer", () => {
  const source = job();
  source.pitch = { ...pitch, word_alignment: null };
  source.transcript = {
    status: "recognized", language: "English", timestamp_reference: "original",
    sections: [], structure_model: null, segments: [{ start_s: 1, end_s: 3, text: "world" }],
    timestamped_text: "[00:01] world\n", reference: null, asr_model: null, word_alignment: null,
  };
  render(() => <><PitchView job={source} /><TranscriptView job={source} /></>);
  expect(screen.queryByText(/Whisper/)).not.toBeInTheDocument();
  expect(screen.getByText(/Recognition model unspecified/)).toBeVisible();
  expect(screen.getByText(/alignment model is unspecified/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^world,/ }));
  expect(document.querySelector("audio")!.currentTime).toBe(1);
  expect(document.querySelectorAll(".pitch-note-selected")).toHaveLength(2);
  expect(source.pitch!.words[0]).toEqual(pitch.words[0]);
});
it("seeks from the ruler in output time across zoom and horizontal scroll, clamping to the analysis duration", () => {
  render(() => <PitchView job={job()} />);
  const ruler = document.querySelector<HTMLElement>(".pitch-ruler")!;
  const viewport = document.querySelector<HTMLElement>(".pitch-viewport")!;
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue({
    x: -600, y: 0, left: -600, top: 0, right: 7000, bottom: 32, width: 7600, height: 32,
    toJSON: () => ({}),
  });
  Object.defineProperty(viewport, "scrollLeft", { configurable: true, writable: true, value: 600 });
  fireEvent.input(screen.getByRole("slider", { name: "Melody zoom" }), { target: { value: "200" } });

  fireEvent.click(screen.getByRole("slider", { name: "Pitch timeline position" }), {
    clientX: -600 + 54 + 13.25 * 200,
  });
  const audio = document.querySelector("audio")!;
  expect(audio.currentTime).toBeCloseTo(13.25);
  expect(document.querySelector(".pitch-playhead")).toHaveAttribute("x1", "2650");
  fireEvent.click(ruler, { clientX: 30 });
  expect(audio.currentTime).toBeCloseTo(13.25);
  fireEvent.click(ruler, { clientX: 100_000 });
  expect(audio.currentTime).toBe(70);
  expect(document.querySelector(".pitch-playhead")).toHaveAttribute("x1", "14000");
  fireEvent.keyDown(ruler, { key: "ArrowLeft" });
  expect(audio.currentTime).toBe(69);
  expect(ruler).toHaveAttribute("aria-valuenow", "69");
  expect(document.querySelector(".pitch-playhead")).toHaveAttribute("x1", "13800");
});

it("switches between full-song and private vocals while preserving output time independently of the analyzed track", () => {
  const source = job();
  source.manifest = [];
  source.has_pitch_vocals = true;
  render(() => <PitchView job={source} />);
  const audio = document.querySelector<HTMLAudioElement>("audio")!;
  const selector = screen.getByRole("combobox", { name: "Pitch background audio" });
  fireEvent.click(document.querySelector(".pitch-note")!);
  expect(audio.currentTime).toBe(1.25);
  fireEvent.change(selector, { target: { value: "vocals" } });
  const background = audio.src;
  Object.defineProperty(audio, "readyState", { configurable: true, value: 4 });
  fireEvent.loadedMetadata(audio);
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBe(1);
  expect(document.querySelector(".pitch-playhead")).toHaveAttribute("x1", "100");
  fireEvent.click(document.querySelector(".pitch-note")!);
  expect(audio.currentTime).toBe(1);
  audio.currentTime = 5;
  fireEvent.timeUpdate(audio);
  expect(document.querySelector(".pitch-playhead")).toHaveAttribute("x1", "500");
  fireEvent.change(screen.getByLabelText("Pitch vocal stem"), { target: { value: "backing" } });
  expect(audio.src).toBe(background);
  fireEvent.change(screen.getByLabelText("Pitch vocal stem"), { target: { value: "vocals" } });
  fireEvent.change(selector, { target: { value: "song" } });
  expect(audio.currentTime).toBe(6.25);
  expect(document.querySelector(".pitch-playhead")).toHaveAttribute("x1", "500");
  expect(audio.paused).toBe(true);
});
it("resets recovered reference and cursor when a different pitch job is mounted into the same view", () => {
  const first = job();
  first.manifest = [];
  first.has_pitch_vocals = true;
  const second = { ...job(), id: 8, manifest: [], has_pitch_vocals: false };
  const [active, setActive] = createSignal<JobDTO>(first);
  render(() => <PitchView job={active()} />);
  const audio = document.querySelector<HTMLAudioElement>("audio")!;
  const selector = screen.getByRole("combobox", { name: "Pitch background audio" }) as HTMLSelectElement;
  fireEvent.change(selector, { target: { value: "vocals" } });
  Object.defineProperty(audio, "readyState", { configurable: true, value: 4 });
  fireEvent.loadedMetadata(audio);
  audio.currentTime = 4;
  fireEvent.timeUpdate(audio);
  expect(document.querySelector(".pitch-playhead")).toHaveAttribute("x1", "400");

  setActive(second);
  const nextAudio = document.querySelector<HTMLAudioElement>("audio")!;
  const nextSelector = screen.getByRole("combobox", { name: "Pitch background audio" }) as HTMLSelectElement;
  expect(nextSelector.value).toBe("song");
  expect([...nextSelector.options].find(option => option.value === "vocals")?.disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Recover cached vocals" })).toBeInTheDocument();
  expect(nextAudio.currentTime).toBe(0);
});

it("offers cached-vocal recovery without enabling missing vocals", () => {
  const source = job();
  source.manifest = [];
  source.has_pitch_vocals = false;
  render(() => <PitchView job={source} />);
  const selector = screen.getByRole("combobox", { name: "Pitch background audio" }) as HTMLSelectElement;
  const vocals = [...selector.options].find(option => option.value === "vocals")!;
  expect(vocals.disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Recover cached vocals" })).toBeInTheDocument();
});
it("shows immediate pitch-and-lyrics note tooltips and lyrics-only word tooltips on hover and focus", () => {
  render(() => <PitchView job={job()} />);
  const note = document.querySelectorAll<SVGGElement>(".pitch-note")[0];
  expect(note.closest("[title]")).toBeNull();
  expect(note.querySelector("[title], title")).toBeNull();
  fireEvent.pointerEnter(note);
  let tooltip = screen.getByRole("tooltip");
  expect(tooltip.querySelector(".pitch-tooltip-note")).toHaveTextContent("C#4");
  expect(tooltip.querySelector(".pitch-tooltip-lyrics")).toHaveTextContent("world");
  expect(tooltip).not.toHaveTextContent(/confidence|approximate|0:01|model/i);
  fireEvent.pointerLeave(note);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.focus(note);
  tooltip = screen.getByRole("tooltip");
  expect(tooltip.querySelector(".pitch-tooltip-note")).toHaveTextContent("C#4");
  expect(tooltip.querySelector(".pitch-tooltip-lyrics")).toHaveTextContent("world");
  fireEvent.blur(note);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

  const word = screen.getByRole("button", { name: /^world,/ });
  expect(word.closest("[title]")).toBeNull();
  expect(word.querySelector("[title], title")).toBeNull();
  fireEvent.pointerEnter(word);
  tooltip = screen.getByRole("tooltip");
  expect(tooltip).toHaveTextContent("world");
  expect(tooltip).not.toHaveTextContent(/C#4|confidence|approximate|0:01|model/i);
  fireEvent.pointerLeave(word);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.focus(word);
  expect(screen.getByRole("tooltip")).toHaveTextContent("world");
  fireEvent.blur(word);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it.each(["note", "word"])("restores a %s tooltip when scrolling leaves the pointer within its target", kind => {
  render(() => <PitchView job={job()} />);
  const target = kind === "note"
    ? document.querySelector<SVGGElement>(".pitch-note")!
    : screen.getByRole("button", { name: /^world,/ });
  fireEvent.pointerEnter(target);
  fireEvent.scroll(window);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent(target, Object.assign(new Event("pointermove", { bubbles: true }), { pointerType: "touch" }));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.click(target);
  expect(screen.getByRole("tooltip")).toHaveTextContent("world");
  for (const pointerType of ["mouse", "pen"]) {
    fireEvent.scroll(window);
    fireEvent(target, Object.assign(new Event("pointermove", { bubbles: true }), { pointerType }));
    expect(screen.getByRole("tooltip")).toBeVisible();
  }
  expect(screen.getByRole("tooltip")).toBeVisible();
  expect(screen.getByRole("tooltip")).toHaveTextContent("world");
  if (kind === "note") expect(screen.getByRole("tooltip")).toHaveTextContent("C#4");
});
it("does not invent lyrics for an unlinked note", () => {
  render(() => <PitchView job={job()} />);
  const note = document.querySelectorAll<SVGGElement>(".pitch-note")[2];
  fireEvent.pointerEnter(note);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.querySelector(".pitch-tooltip-note")).toHaveTextContent("E4");
  expect(tooltip.querySelector(".pitch-tooltip-lyrics")).not.toBeInTheDocument();
  expect(tooltip).not.toHaveTextContent(/world|approximate|confidence/i);
});

it.each([300, 900])("follows after three quarters of the visible note region at viewport width %i", width => {
  const player = scrollPlayer();
  Object.defineProperty(player.viewport, "clientWidth", { configurable: true, value: width });
  player.time(10);
  const left = player.viewport.scrollLeft;
  expect(left).toBeGreaterThan(0);
  const crossing = (left + (width - 54) * 0.75) / 100;
  player.time(crossing - 0.001);
  expect(player.viewport.scrollLeft).toBe(left);
  player.time(crossing + 0.001);
  expect(player.viewport.scrollLeft).toBeGreaterThan(left);
  expect(player.audio.currentTime).toBe(crossing + 0.001);
});

it("keeps the three-quarter trigger suspended until a settled manual return", () => {
  const player = scrollPlayer();
  player.time(10);
  player.wheel(3000);
  player.end();
  player.time(30.5);
  player.time(32);
  expect(player.viewport.scrollLeft).toBe(3000);
  player.wheel(3500);
  player.end();
  player.wheel(3077); // Return the current playhead to the middle of the note region.
  player.end();
  const crossing = (3077 + (300 - 54) * 0.75) / 100;
  player.time(crossing - 0.001);
  expect(player.viewport.scrollLeft).toBe(3077);
  player.time(crossing + 0.001);
  expect(player.viewport.scrollLeft).toBeGreaterThan(3077);
});

it("does not confuse automatic scrolling with browsing, and resumes only after a manual return", () => {
  const player = scrollPlayer();
  player.time(5);
  const automatic = player.viewport.scrollLeft;
  player.scroll(automatic);
  expect(player.browsing()).toBe(false);
  player.time(9);
  expect(player.viewport.scrollLeft).toBeGreaterThan(automatic);
  player.wheel(2000);
  player.end();
  expect(player.browsing()).toBe(true);
  player.time(20.5); // The moving playhead enters the stationary browsed window.
  expect(player.viewport.scrollLeft).toBe(2000);
  player.time(24); // And leaves it again, without a user return.
  expect(player.viewport.scrollLeft).toBe(2000);
  player.wheel(2300);
  expect(player.browsing()).toBe(true);
  player.end();
  expect(player.browsing()).toBe(false);
  player.time(28);
  expect(player.viewport.scrollLeft).toBeGreaterThan(2300);
});

it.each(["no motion", "pinch", "prevented"])("does not strand following after %s wheel input", kind => {
  const player = scrollPlayer();
  player.time(5);
  const initial = player.viewport.scrollLeft;
  const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 0.01, ctrlKey: kind === "pinch" });
  if (kind === "prevented") wheel.preventDefault();
  fireEvent(player.viewport, wheel);
  if (kind !== "no motion") player.scroll(initial + 10); // Browser layout adjustment, not a claimed pan.
  player.time(9);
  expect(player.viewport.scrollLeft).toBeGreaterThan(initial + 10);
  expect(player.browsing()).toBe(false);
  player.wheel(3000);
  player.time(10);
  expect(player.viewport.scrollLeft).toBe(3000);
});

it("excludes the sticky note axis when recognizing a manual return", () => {
  const player = scrollPlayer();
  player.time(5);
  player.wheel(700);
  player.end();
  player.wheel(520); // x=554 is inside the viewport, but behind its 54px axis.
  player.end();
  expect(player.browsing()).toBe(true);
  player.time(5.1);
  expect(player.viewport.scrollLeft).toBe(520);
  player.wheel(490);
  player.end();
  expect(player.browsing()).toBe(false);
});

it("retains a genuine return while playback advances beyond a high-zoom view before the gesture ends", () => {
  const player = scrollPlayer();
  fireEvent.input(screen.getByRole("slider", { name: "Melody zoom" }), { target: { value: "640" } });
  player.time(5);
  fireEvent.pointerDown(player.viewport, { pointerId: 1 });
  player.scroll(4000);
  player.scroll(3200);
  player.time(6);
  player.end();
  expect(player.browsing()).toBe(true);
  expect(player.viewport.scrollLeft).toBe(3200);
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(player.browsing()).toBe(false);
  player.time(6.1);
  expect(player.viewport.scrollLeft).toBeGreaterThan(3200);
});

it("revokes a pending return if the user pans away again before releasing the pointer", () => {
  const player = scrollPlayer();
  player.time(5);
  fireEvent.pointerDown(player.viewport, { pointerId: 1 });
  player.scroll(2000);
  player.scroll(470);
  player.scroll(2100);
  player.end();
  fireEvent.pointerUp(window, { pointerId: 1 });
  player.time(6);
  expect(player.browsing()).toBe(true);
  expect(player.viewport.scrollLeft).toBe(2100);
});

it("suspends on vertical browsing and preserves suspension through pause, seek, source, zoom and preference changes", () => {
  const player = scrollPlayer();
  player.state.paused = true;
  player.time(5);
  player.wheel(player.viewport.scrollLeft, player.viewport.scrollTop + 40);
  player.end();
  expect(player.browsing()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Forward 5 seconds" }));
  fireEvent.change(screen.getByLabelText("Pitch background audio"), { target: { value: "song" } });
  fireEvent.loadedMetadata(player.audio);
  fireEvent.timeUpdate(player.audio);
  fireEvent.input(screen.getByRole("slider", { name: "Melody zoom" }), { target: { value: "200" } });
  player.scroll(player.viewport.scrollLeft);
  const stopped = player.viewport.scrollLeft;
  const preference = screen.getByRole("checkbox", { name: "Follow playback" });
  fireEvent.click(preference);
  fireEvent.click(preference);
  player.state.paused = false;
  player.time(30);
  expect(player.browsing()).toBe(true);
  expect(player.viewport.scrollLeft).toBe(stopped);
  fireEvent.click(preference); // An explicit opt-out survives a manual return.
  player.wheel(10_000);
  player.end();
  player.wheel(4600);
  player.end();
  player.time(40);
  expect(preference).not.toBeChecked();
  expect(player.viewport.scrollLeft).toBe(4600);
});

it("waits for touch and keyboard gestures to finish before honoring their return", () => {
  const player = scrollPlayer();
  player.time(5);
  player.wheel(2000);
  player.end();
  fireEvent.pointerDown(player.viewport, { pointerId: 1, pointerType: "touch" });
  fireEvent.touchStart(player.viewport, { touches: [{ identifier: 1 }] });
  player.scroll(470);
  fireEvent.pointerCancel(window, { pointerId: 1, pointerType: "touch" });
  player.end();
  expect(player.browsing()).toBe(true);
  fireEvent.touchEnd(window, { touches: [] });
  expect(player.browsing()).toBe(false);
  player.wheel(2000);
  player.end();
  fireEvent.keyDown(player.viewport, { key: "ArrowLeft" });
  player.scroll(470);
  player.end();
  expect(player.browsing()).toBe(true);
  fireEvent.keyUp(window, { key: "ArrowLeft" });
  expect(player.browsing()).toBe(false);
});

it("settles legacy scrolling across paint frames and immediately suspends again on late momentum", () => {
  const frame = animationFrames();
  const player = scrollPlayer();
  const removed: [object, PropertyDescriptor][] = [];
  for (let owner: object | null = player.viewport; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "onscrollend");
    if (descriptor) {
      removed.push([owner, descriptor]);
      Reflect.deleteProperty(owner, "onscrollend");
    }
  }
  try {
    player.time(5);
    player.wheel(2000);
    player.wheel(470);
    frame();
    player.scroll(480);
    frame();
    player.scroll(480, player.viewport.scrollTop + 10);
    frame();
    expect(player.browsing()).toBe(true);
    player.time(20);
    frame();
    expect(player.browsing()).toBe(false);
    player.scroll(460); // Late native inertia, without another wheel event.
    player.time(21);
    expect(player.browsing()).toBe(true);
    expect(player.viewport.scrollLeft).toBe(460);
  } finally {
    for (const [owner, descriptor] of removed) Object.defineProperty(owner, "onscrollend", descriptor);
  }
});

it("advances karaoke and output position between timeupdate events using the actual original-media clock", () => {
  const frame = animationFrames();
  const source = job();
  source.manifest = [];
  source.has_pitch_vocals = false;
  const player = scrollPlayer(source);
  fireEvent.play(player.audio);
  player.audio.currentTime = 1.875;
  frame();
  expect(screen.getByRole("slider", { name: "Pitch timeline position" })).toHaveAttribute("aria-valuenow", "1.5");
  expect(screen.getByRole("region", { name: "Current karaoke line" }).querySelector('[aria-current="true"]')).toHaveTextContent("world");
  player.audio.currentTime = 2.5;
  frame();
  expect(screen.getByRole("slider", { name: "Pitch timeline position" })).toHaveAttribute("aria-valuenow", "2");
  player.unmount();
  frame();
});

it.each(["pause", "ended", "emptied", "error"])("stops the frame clock on the native %s event", event => {
  const frame = animationFrames();
  const player = scrollPlayer();
  fireEvent.play(player.audio);
  player.audio.currentTime = 1.5;
  frame();
  fireEvent(player.audio, new Event(event));
  player.audio.currentTime = 3;
  frame();
  expect(screen.getByRole("slider", { name: "Pitch timeline position" })).toHaveAttribute("aria-valuenow", "1.5");
  if (event === "error") expect(screen.getByRole("alert")).toBeVisible();
});

it("skips five output seconds across original/private clocks, clamps endpoints and preserves playback state and source", () => {
  const source = job();
  source.manifest = [];
  const player = scrollPlayer(source);
  player.state.paused = true;
  player.audio.volume = 0.4;
  const back = screen.getByRole("button", { name: "Back 5 seconds" });
  const forward = screen.getByRole("button", { name: "Forward 5 seconds" });
  fireEvent.click(back);
  expect(player.audio.currentTime).toBe(0);
  fireEvent.click(forward);
  expect(player.audio.currentTime).toBe(6.25);
  expect(player.audio.paused).toBe(true);
  const selector = screen.getByLabelText("Pitch background audio");
  fireEvent.change(selector, { target: { value: "vocals" } });
  fireEvent.click(forward); // While the source's metadata/seek is pending.
  fireEvent.loadedMetadata(player.audio);
  expect(player.audio.currentTime).toBe(10);
  player.state.paused = false;
  fireEvent.click(back);
  fireEvent.seeked(player.audio);
  expect(player.audio.currentTime).toBe(5);
  expect(player.audio.paused).toBe(false);
  expect(player.audio.volume).toBe(0.4);
  player.time(68);
  fireEvent.click(forward);
  expect(player.audio.currentTime).toBe(pitch.duration_s);
  fireEvent.change(selector, { target: { value: "song" } });
  fireEvent.loadedMetadata(player.audio);
  fireEvent.click(forward);
  expect(player.audio.currentTime).toBe(pitch.source_duration_s);
});
