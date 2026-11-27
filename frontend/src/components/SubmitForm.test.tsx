import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "~/api";
import SubmitForm from "./SubmitForm";

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return { ...actual, submitJob: vi.fn(), analyzeKey: vi.fn() };
});

const submitButton = () => screen.getByRole("button", { name: /download song|process audio/i });
const queuedProgress: api.JobProgress = { steps: ["source", "analysis", "export"], current: null };

const existingSong: api.SongSummary = {
  id: 301, title: "Existing song", source_type: "upload", source_value: "original.wav",
  created_at: 1, open_count: 2, has_original: true, original_key: "D major", original_work_id: 71, latest_work_id: 72,
  status: "done", active_work_id: null, active_work_ids: [],
  availability: { audio: true, karaoke: false, lyrics: false, pitched_lyrics: false },
};
describe("SubmitForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: null });
  });


  it("ignores a retained invalid URL while adding outputs and restores it when choosing another source", async () => {
    const [target, setTarget] = createSignal<api.SongSummary | null>(null);
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 301, work_id: null, status: "done", position: null, progress: null });
    const view = render(() => <SubmitForm target={target()} onClearTarget={() => setTarget(null)} onSubmitted={vi.fn()} />);
    const url = screen.getByLabelText("Track URL") as HTMLInputElement;
    fireEvent.input(url, { target: { value: "invalid url" } });
    expect(url.checkValidity()).toBe(false);
    setTarget(existingSong);
    expect(view.container.querySelector("form")!.checkValidity()).toBe(true);
    await userEvent.click(submitButton());
    await userEvent.click(screen.getByRole("button", { name: "Choose another source" }));
    expect(screen.getByLabelText("Track URL")).toHaveValue("invalid url");
    expect((screen.getByLabelText("Track URL") as HTMLInputElement).checkValidity()).toBe(false);
  });

  it("clears augmentation when a new URL or upload is chosen", async () => {
    const [target, setTarget] = createSignal<api.SongSummary | null>(existingSong);
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 302, work_id: 89, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm target={target()} onClearTarget={() => setTarget(null)} onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Choose another source" }));
    fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.com/other" } });
    await userEvent.click(submitButton());
    expect(screen.getByLabelText("Track URL")).toHaveValue("https://example.com/other");
    expect(screen.queryByText(/Adding outputs to Existing song/)).not.toBeInTheDocument();
    setTarget(existingSong);
    await userEvent.click(screen.getByRole("button", { name: "Choose another source" }));
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    const file = new File(["different source"], "other.wav", { type: "audio/wav" });
    await userEvent.upload(screen.getByLabelText("Audio file"), file);
    await userEvent.click(submitButton());
    expect(screen.getByText("Selected: other.wav")).toBeVisible();
    expect(screen.queryByText(/Adding outputs to Existing song/)).not.toBeInTheDocument();
  });
  it("uses the selected song key and ignores stale source analysis until a new source is chosen", async () => {
    const delayed = Promise.withResolvers<api.KeyAnalysis>();
    vi.mocked(api.analyzeKey).mockImplementation(async source => {
      if (source.file?.name === "pending.wav") return delayed.promise;
      return { original_key: source.file?.name === "new.wav" ? "E major" : "C major" };
    });
    const [target, setTarget] = createSignal<api.SongSummary | null>(null);
    render(() => <SubmitForm target={target()} onClearTarget={() => setTarget(null)} onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    const input = screen.getByLabelText("Audio file");
    await userEvent.upload(input, new File(["first"], "first.wav", { type: "audio/wav" }));
    expect(await screen.findByText("Original key: C major")).toBeVisible();
    await userEvent.upload(input, new File(["pending"], "pending.wav", { type: "audio/wav" }));
    await waitFor(() => expect(api.analyzeKey).toHaveBeenCalledTimes(2));
    setTarget(existingSong);
    const pitch = screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" });
    fireEvent.input(pitch, { target: { value: "2" } });
    expect(await screen.findByText("Original key: D major")).toBeVisible();
    expect(pitch).toHaveAccessibleDescription("Resulting key: E major");
    delayed.resolve({ original_key: "C major" });
    await delayed.promise;
    expect(screen.getByText("Original key: D major")).toBeVisible();
    expect(pitch).toHaveAccessibleDescription("Resulting key: E major");
    await userEvent.click(screen.getByRole("button", { name: "Choose another source" }));
    await userEvent.upload(input, new File(["new"], "new.wav", { type: "audio/wav" }));
    expect(await screen.findByText("Original key: E major")).toBeVisible();
    expect(pitch).toHaveAccessibleDescription("Resulting key: Gb major");
  });

  it("analyzes a newly entered URL instead of retaining the selected song key", async () => {
    const [target, setTarget] = createSignal<api.SongSummary | null>(existingSong);
    vi.mocked(api.analyzeKey).mockResolvedValueOnce({ original_key: "F major" });
    render(() => <SubmitForm target={target()} onClearTarget={() => setTarget(null)} onSubmitted={vi.fn()} />);
    expect(await screen.findByText("Original key: D major")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Choose another source" }));
    fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.com/new-song" } });
    expect(await screen.findByText("Original key: F major")).toBeVisible();
  });
  it("ignores duplicate submits while pending and preserves the source on error", async () => {
    const pending = Promise.withResolvers<api.SubmitResult>();
    vi.mocked(api.submitJob).mockReturnValueOnce(pending.promise);
    const { container } = render(() => <SubmitForm onSubmitted={vi.fn()} />);
    fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.com/song" } });
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(api.submitJob).toHaveBeenCalledTimes(1);
    pending.reject(new Error("Queue unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Queue unavailable");
    expect(screen.getByLabelText("Track URL")).toHaveValue("https://example.com/song");
  });

  it("blocks submit and shows an error when neither URL nor file is given", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);

    await userEvent.click(submitButton());

    expect(screen.getByText(/provide a url or choose a file/i)).toBeInTheDocument();
    expect(api.submitJob).not.toHaveBeenCalled();
  });

  it.each([
    ["song.mp3", "audio/mpeg"],
    ["song.MP3", "application/octet-stream"],
    ["song.mp3", ""],
    ["song.wav", "application/octet-stream"],
  ])("analyzes and submits %s reported as %s without changing the file", async (name, type) => {
    vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: "C major" });
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 113, work_id: 13, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    const source = new File(["provider audio"], name, { type });
    await userEvent.upload(screen.getByLabelText("Audio file"), source);
    expect(await screen.findByText(`Selected: ${name}`)).toBeInTheDocument();
    expect(await screen.findByText("Original key: C major")).toBeInTheDocument();
    await userEvent.click(submitButton());
    expect(screen.getByText(`Selected: ${name}`)).toBeVisible();
  });

  it("retains fractional pitch and positive fractional tempo after submission", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 107, work_id: 7, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);

    const pitch = screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" });
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (% of original)" });
    expect(pitch).toHaveValue(0);
    expect(tempo).toHaveValue(100);
    await userEvent.clear(pitch);
    await userEvent.type(pitch, "-2.25");
    await userEvent.clear(tempo);
    await userEvent.type(tempo, "120.5");
    expect(pitch).toHaveValue(-2.25);
    expect(tempo).toHaveValue(120.5);
    await userEvent.type(screen.getByPlaceholderText("https://..."), "https://example.com/x");
    await userEvent.click(submitButton());

    await waitFor(() => expect(api.submitJob).toHaveBeenCalled());
    expect(pitch).toHaveValue(-2.25);
    expect(tempo).toHaveValue(120.5);
  });

  it("previews the pitched full source alongside selected stems and removes it when pitch resets", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Extract instruments", exact: true }));
    const pitch = screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" });
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (% of original)" });
    fireEvent.input(pitch, { target: { value: "-1.25" } });
    fireEvent.input(tempo, { target: { value: "119.5" } });
    expect(screen.getByText("Original (unchanged)", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Full song (pitch -1.25 st, tempo 119.5%)", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("instruments (pitch -1.25 st, tempo 119.5%)", { exact: true })).toBeInTheDocument();
    fireEvent.input(pitch, { target: { value: "0" } });
    expect(screen.queryByText(/^Full song/)).not.toBeInTheDocument();
    expect(screen.getByText("instruments (tempo 119.5%)", { exact: true })).toBeInTheDocument();
  });

  it("shows the resulting key inside the editable pitch field and clears unknown and invalid keys", async () => {
    vi.mocked(api.analyzeKey).mockResolvedValueOnce({ original_key: "C major" });
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 110, work_id: 10, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    const pitch = screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" });
    const badge = () => pitch.parentElement!.querySelector(".pitch-key-badge");
    expect(badge()).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    const source = screen.getByLabelText("Audio file");
    await userEvent.upload(source, new File(["audio"], "C-major.wav", { type: "audio/wav" }));
    await waitFor(() => expect(pitch).toHaveAccessibleDescription("Resulting key: C major"));
    expect(pitch).toHaveValue(0);
    expect(badge()).toHaveTextContent("C major");
    await userEvent.click(screen.getByRole("button", { name: "Increase pitch" }));
    await userEvent.click(screen.getByRole("button", { name: "Increase pitch" }));
    expect(pitch).toHaveValue(2);
    expect(badge()).toHaveTextContent("D major");
    await userEvent.clear(pitch);
    expect(badge()).not.toBeInTheDocument();
    expect(pitch).not.toHaveAttribute("aria-describedby");
    await userEvent.type(pitch, "-2.25");
    expect(badge()).toHaveTextContent("Bb major (-25 cents)");

    const next = Promise.withResolvers<api.KeyAnalysis>();
    vi.mocked(api.analyzeKey).mockReturnValueOnce(next.promise);
    await userEvent.upload(source, new File(["next"], "unknown.wav", { type: "audio/wav" }));
    expect(badge()).not.toBeInTheDocument();
    next.resolve({ original_key: null });
    await screen.findByText("Original key: Undetermined");
    expect(badge()).not.toBeInTheDocument();

    vi.mocked(api.analyzeKey).mockResolvedValueOnce({ original_key: "C major" });
    await userEvent.upload(source, new File(["known"], "known.wav", { type: "audio/wav" }));
    expect(badge()).toHaveTextContent("Bb major (-25 cents)");
    await userEvent.click(submitButton());
    await waitFor(() => expect(pitch).toHaveValue(-2.25));
    expect(badge()).toHaveTextContent("Bb major (-25 cents)");
    expect(pitch).toHaveAttribute("aria-describedby");
  });
  it("keeps URL and selections edited during a pending submission", async () => {
    const pending = Promise.withResolvers<api.SubmitResult>();
    vi.mocked(api.submitJob).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ song_id: 111, work_id: 11, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    const url = screen.getByLabelText("Track URL");
    fireEvent.input(url, { target: { value: "https://example.com/song" } });
    const vocals = screen.getByRole("checkbox", { name: "Extract vocals", exact: true });
    await userEvent.click(vocals);
    const pitch = screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" });
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (% of original)" });
    fireEvent.input(pitch, { target: { value: "-1.25" } });
    fireEvent.input(tempo, { target: { value: "119.5" } });
    await userEvent.click(screen.getByRole("tab", { name: "Review" }));

    await userEvent.click(submitButton());
    fireEvent.input(url, { target: { value: "https://example.com/edited" } });
    fireEvent.input(pitch, { target: { value: "2.5" } });
    pending.resolve({ song_id: 110, work_id: 10, status: "queued", position: 1, progress: queuedProgress });
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(url).toHaveValue("https://example.com/edited");
    expect(pitch).toHaveValue(2.5);
    expect(tempo).toHaveValue(119.5);
    expect(vocals).toBeChecked();
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(submitButton());
  });

  it("retains form state when submission fails", async () => {
    vi.mocked(api.submitJob).mockRejectedValueOnce(new Error("Queue unavailable"));
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    const url = screen.getByLabelText("Track URL");
    fireEvent.input(url, { target: { value: "https://example.com/song" } });
    const vocals = screen.getByRole("checkbox", { name: "Extract vocals", exact: true });
    await userEvent.click(vocals);
    await userEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Queue unavailable");
    expect(url).toHaveValue("https://example.com/song");
    expect(vocals).toBeChecked();
  });


  it("steps pitch and tempo from defaults and fractional entries and updates previews", async () => {
    vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: "C major" });
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 108, work_id: 8, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    await userEvent.upload(screen.getByLabelText("Audio file"), new File(["audio"], "song.wav", { type: "audio/wav" }));
    await screen.findByText("Original key: C major");

    const pitch = screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" });
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (% of original)" });
    await userEvent.click(screen.getByRole("button", { name: "Increase pitch" }));
    expect(pitch).toHaveValue(1);
    expect(screen.getByText("Target key: Db major")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Decrease pitch" }));
    expect(pitch).toHaveValue(0);
    await userEvent.click(screen.getByRole("button", { name: "Decrease pitch" }));
    expect(pitch).toHaveValue(-1);
    await userEvent.click(screen.getByRole("button", { name: "Decrease tempo" }));
    expect(tempo).toHaveValue(99);
    await userEvent.click(screen.getByRole("button", { name: "Increase tempo" }));
    expect(tempo).toHaveValue(100);

    await userEvent.clear(pitch);
    await userEvent.type(pitch, "-2.25");
    await userEvent.click(screen.getByRole("button", { name: "Increase pitch" }));
    expect(pitch).toHaveValue(-1.25);
    await userEvent.clear(tempo);
    await userEvent.type(tempo, "120.5");
    await userEvent.click(screen.getByRole("button", { name: "Decrease tempo" }));
    expect(tempo).toHaveValue(119.5);
    expect(screen.getByText("Full song (pitch -1.25 st, tempo 119.5%)")).toBeInTheDocument();
    expect(screen.getByText("Original (unchanged)")).toBeInTheDocument();
    await userEvent.click(submitButton());
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(pitch).toHaveValue(-1.25);
    expect(tempo).toHaveValue(119.5);
  });

  it("keeps tempo strictly positive without imposing a minimum on fractional manual entry", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (% of original)" });
    const decrease = screen.getByRole("button", { name: "Decrease tempo" });
    const increase = screen.getByRole("button", { name: "Increase tempo" });
    await userEvent.clear(tempo);
    await userEvent.type(tempo, "2");
    await userEvent.click(decrease);
    expect(tempo).toHaveValue(1);
    expect(decrease).toBeDisabled();
    await userEvent.click(decrease);
    expect(tempo).toHaveValue(1);

    await userEvent.clear(tempo);
    await userEvent.type(tempo, "0.25");
    expect(tempo).toHaveValue(0.25);
    expect(decrease).toBeDisabled();
    await userEvent.click(increase);
    expect(tempo).toHaveValue(1.25);
    expect(decrease).toBeEnabled();
    await userEvent.click(decrease);
    expect(tempo).toHaveValue(0.25);
  });

  it("does not replace incomplete manual entries with a button fallback", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    for (const [label, name] of [
      ["Pitch shift (semitones)", "pitch"],
      ["Tempo (% of original)", "tempo"],
    ]) {
      const input = screen.getByRole("spinbutton", { name: label });
      await userEvent.clear(input);
      expect(screen.getByRole("button", { name: `Decrease ${name}` })).toBeDisabled();
      expect(screen.getByRole("button", { name: `Increase ${name}` })).toBeDisabled();
      expect(input).toHaveValue(null);
      await userEvent.type(input, "1.5");
      await userEvent.click(screen.getByRole("button", { name: `Increase ${name}` }));
      expect(input).toHaveValue(2.5);
    }
  });

  it.each(["0", "-20", ""])("rejects nonpositive or missing tempo (%s)", async (value) => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText("https://..."), "https://example.com/x");
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (% of original)" });
    await userEvent.clear(tempo);
    if (value) await userEvent.type(tempo, value);
    await userEvent.click(submitButton());

    expect(screen.getByText("Tempo must be a positive, finite number.")).toBeInTheDocument();
    expect(api.submitJob).not.toHaveBeenCalled();
  });

  it("rejects a cleared pitch rather than serializing NaN", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText("https://..."), "https://example.com/x");
    await userEvent.clear(screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" }));
    await userEvent.click(submitButton());

    expect(screen.getByText("Pitch shift must be a finite number.")).toBeInTheDocument();
    expect(api.submitJob).not.toHaveBeenCalled();
  });

  it("has accessible extraction controls and previews a queued mix by name", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    expect(screen.getByText("Tracks and files you'll get (1)")).toBeInTheDocument();
    const extract = screen.getByRole("checkbox", { name: "Extract vocals" });
    expect(extract).not.toBeChecked();
    await userEvent.click(screen.getByText("Extract vocals"));
    expect(extract).toBeChecked();
    expect(screen.getByRole("button", { name: "Process audio" })).toBeInTheDocument();
    expect(screen.getByText("vocals", { exact: true })).toBeInTheDocument();
    await userEvent.click(extract);
    // Build a mix from 2+ parts; the preview shows the mix, not its ingredients.
    await userEvent.click(screen.getByRole("button", { name: "Drums" }));
    await userEvent.click(screen.getByRole("button", { name: "Bass" }));
    await userEvent.click(screen.getByRole("button", { name: "Add mix" }));
    expect(screen.getByText("Tracks and files you'll get (2)")).toBeInTheDocument();
    expect(screen.getAllByText("Drums + Bass", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.queryByText("vocals", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("instruments", { exact: true })).not.toBeInTheDocument();
  });
  it("previews pitched lyric targets without selecting internal analysis outputs", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Lyrics with pitches", exact: true }));
    expect(screen.getByText("Tracks and files you'll get (2)")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Extract lyrics", exact: true })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true })).not.toBeChecked();
    expect(screen.queryByText("Lyrics (timestamped TXT)")).toBeNull();
    expect(screen.queryByText("Karaoke with pitches + JSON")).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "Split lead & backing vocals", exact: true }));
    expect(screen.getByText("Tracks and files you'll get (5)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Dereverb (remove reverb)", exact: true }));
    expect(screen.getByText("Tracks and files you'll get (9)")).toBeInTheDocument();
  });

  it("includes and locks karaoke outputs and preserves later edits during submission", async () => {
    const pending = Promise.withResolvers<api.SubmitResult>();
    vi.mocked(api.submitJob).mockReturnValueOnce(pending.promise);
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.com/karaoke" } });
    const karaoke = screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true });
    const vocals = screen.getByRole("checkbox", { name: "Extract vocals", exact: true });
    const lyrics = screen.getByRole("checkbox", { name: "Extract lyrics", exact: true });
    const instruments = screen.getByRole("checkbox", { name: "Extract instruments", exact: true });
    const drums = screen.getByRole("checkbox", { name: "Split drums, bass & other instruments", exact: true });
    const pitched = screen.getByRole("checkbox", { name: "Lyrics with pitches", exact: true });
    await userEvent.click(karaoke);
    for (const included of [vocals, lyrics, pitched, instruments, drums]) {
      expect(included).toBeChecked();
      expect(included).toBeDisabled();
      await userEvent.click(included);
      expect(included).toBeChecked();
    }
    expect(screen.getByText("vocals", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Lyrics (timestamped TXT)")).toBeInTheDocument();
    for (const label of ["instruments", "drums", "bass", "other-instruments"]) {
      expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
    }
    expect(screen.getByText("Drums + Vocals", { exact: true })).toBeInTheDocument();
    for (const name of ["Split by gender (male/female)", "Split lead & backing vocals"]) {
      expect(screen.getByRole("checkbox", { name, exact: true })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name, exact: true })).toBeEnabled();
    }
    await userEvent.click(submitButton());
    await userEvent.click(karaoke);
    expect(vocals).not.toBeChecked();
    expect(lyrics).not.toBeChecked();
    expect(pitched).not.toBeChecked();
    expect(instruments).not.toBeChecked();
    expect(drums).not.toBeChecked();
    expect(screen.queryByText("Drums + Vocals", { exact: true })).toBeNull();
    pending.resolve({ song_id: 142, work_id: 42, status: "queued", position: 1, progress: queuedProgress });
    await waitFor(() => expect(submitButton()).toBeEnabled());
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "restores prior vocals=%s and lyrics=%s while preserving independent selections and source edits",
    async (wantedVocals, wantedLyrics) => {
      vi.mocked(api.submitJob).mockResolvedValue({ song_id: 143, work_id: 43, status: "queued", position: 1, progress: queuedProgress });
      render(() => <SubmitForm onSubmitted={vi.fn()} />);
      const karaoke = screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true });
      const vocals = screen.getByRole("checkbox", { name: "Extract vocals", exact: true });
      const lyrics = screen.getByRole("checkbox", { name: "Extract lyrics", exact: true });
      const pitchedText = screen.getByRole("checkbox", { name: "Lyrics with pitches", exact: true });
      const drums = screen.getByRole("checkbox", { name: "Split drums, bass & other instruments", exact: true });
      if (wantedVocals) await userEvent.click(vocals);
      if (wantedLyrics) await userEvent.click(lyrics);
      await userEvent.click(pitchedText);
      await userEvent.click(drums);
      await userEvent.click(karaoke);
      await userEvent.click(screen.getByRole("button", { name: "Upload audio", exact: true }));
      await userEvent.click(screen.getByRole("button", { name: "From URL", exact: true }));
      expect(pitchedText).toBeChecked();
      expect(pitchedText).toBeDisabled();
      expect(vocals).toBeDisabled();
      expect(lyrics).toBeDisabled();
      await userEvent.click(karaoke);
      expect((vocals as HTMLInputElement).checked).toBe(wantedVocals);
      expect((lyrics as HTMLInputElement).checked).toBe(wantedLyrics);
      expect(vocals).toBeEnabled();
      expect(lyrics).toBeEnabled();
      expect(pitchedText).toBeChecked();
      expect(drums).toBeChecked();
      expect(karaoke).not.toBeChecked();
      fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.com/independent" } });
      await userEvent.click(submitButton());
    },
  );

  it.each([false, true])("restores the prior pitched-lyrics selection (%s) after karaoke", async (wanted) => {
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 145, work_id: 45, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    const karaoke = screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true });
    const pitched = screen.getByRole("checkbox", { name: "Lyrics with pitches", exact: true });
    if (wanted) await userEvent.click(pitched);
    await userEvent.click(karaoke);
    expect(pitched).toBeChecked();
    expect(pitched).toBeDisabled();
    await userEvent.click(pitched);
    expect(pitched).toBeChecked();
    await userEvent.click(karaoke);
    expect(pitched).toBeEnabled();
    expect((pitched as HTMLInputElement).checked).toBe(wanted);
    fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.com/source" } });
    await userEvent.click(submitButton());
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "restores public instruments=%s and drums=%s independently after karaoke, without inserting mixes",
    async (wantedInstruments, wantedDrums) => {
      vi.mocked(api.submitJob).mockResolvedValue({ song_id: 144, work_id: 44, status: "queued", position: 1, progress: queuedProgress });
      render(() => <SubmitForm onSubmitted={vi.fn()} />);
      fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.com/backings" } });
      const karaoke = screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true });
      const instruments = screen.getByRole("checkbox", { name: "Extract instruments", exact: true });
      const drums = screen.getByRole("checkbox", { name: "Split drums, bass & other instruments", exact: true });
      if (wantedInstruments) await userEvent.click(instruments);
      if (wantedDrums) await userEvent.click(drums);
      await userEvent.click(screen.getByRole("button", { name: "Drums", exact: true }));
      await userEvent.click(screen.getByRole("button", { name: "Bass", exact: true }));
      await userEvent.click(screen.getByRole("button", { name: "Add mix", exact: true }));
      await userEvent.click(karaoke);
      expect(instruments).toBeChecked();
      expect(drums).toBeChecked();
      expect(instruments).toBeDisabled();
      expect(drums).toBeDisabled();
      await userEvent.click(submitButton());
      await waitFor(() => expect(submitButton()).toBeEnabled());
      await userEvent.click(karaoke);
      expect((instruments as HTMLInputElement).checked).toBe(wantedInstruments);
      expect((drums as HTMLInputElement).checked).toBe(wantedDrums);
      expect(instruments).toBeEnabled();
      expect(drums).toBeEnabled();
      // Drums' internal instrumental prerequisite is not a public selection.
      expect(screen.queryByText("instruments", { exact: true }) !== null).toBe(wantedInstruments);
      for (const label of ["drums", "bass", "other-instruments"]) {
        expect(screen.queryByText(label, { exact: true }) !== null).toBe(wantedDrums);
      }
      await userEvent.click(submitButton());
    },
  );

  it("explains the included drum backing and its extra public downloads to keyboard users", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true }));
    const help = screen.getByRole("button", { name: "Why Split drums, bass & other instruments is included" });
    help.focus();
    expect(screen.getByRole("tooltip")).toBeVisible();
    expect(help).toHaveAccessibleDescription(/drums-only and Drums \+ Vocals backing tracks.*Drums, bass and other instruments.*downloads/);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Split drums, bass & other instruments", exact: true })).toBeDisabled();
  });

  it("places desktop help above its option when it would overflow, and repositions on scroll", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true }));
    const help = screen.getByRole("button", { name: "Why Split drums, bass & other instruments is included" });
    const row = help.parentElement!;
    const tooltip = row.querySelector('[role="tooltip"]') as HTMLElement;
    let top = window.innerHeight - 40;
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() =>
      ({ top, bottom: top + 40 } as DOMRect));
    vi.spyOn(tooltip, "getBoundingClientRect").mockImplementation(() =>
      ({ height: 100 } as DOMRect));
    fireEvent.focus(help);
    expect(tooltip.style.bottom).toBe("100%");
    expect(tooltip.style.top).toBe("auto");
    top = 100;
    fireEvent.scroll(window);
    expect(tooltip.style.bottom).toBe("");
    expect(tooltip.style.top).toBe("");
  });

  it("explains a disabled lyric selection immediately on hover, keyboard focus and an info-button click", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true }));
    const help = screen.getByRole("button", { name: "Why Extract lyrics is included" });
    fireEvent.pointerEnter(help.parentElement!);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/timed word highlighting/);
    fireEvent.pointerLeave(help.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    help.focus();
    expect(screen.getByRole("tooltip")).toBeVisible();
    expect(help).toHaveAccessibleDescription(/timed word highlighting/);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.blur(help);
    fireEvent.click(help);
    expect(screen.getByRole("tooltip")).toBeVisible();
    expect(api.submitJob).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Karaoke with pitches", exact: true }));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Extract lyrics", exact: true })).toBeEnabled();
  });
  it("previews lyrics as a separate original-clock TXT output without audio transforms", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Track URL"), "https://example.com/song");
    const lyrics = screen.getByRole("checkbox", { name: "Extract lyrics", exact: true });
    expect(lyrics).not.toBeChecked();
    await userEvent.click(lyrics);
    expect(screen.getByText("Lyrics (timestamped TXT)")).toBeInTheDocument();
    expect(screen.getByText("Tracks and files you'll get (2)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Process audio" })).toBeInTheDocument();
    expect(screen.getAllByText("Original (unchanged)")).toHaveLength(1);
    await userEvent.click(screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" }));
    await userEvent.clear(screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" }));
    await userEvent.type(screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" }), "2");
    expect(screen.getByText("Lyrics (timestamped TXT)")).toBeInTheDocument();
    expect(screen.getByText("Full song (pitch +2 st)")).toBeInTheDocument();
  });


  it("analyzes an attached file automatically and updates the target key and notes", async () => {
    const { promise, resolve } = Promise.withResolvers<api.KeyAnalysis>();
    vi.mocked(api.analyzeKey).mockReturnValue(promise);
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    const source = new File(["audio"], "G-major.wav", { type: "audio/wav" });
    await userEvent.upload(screen.getByLabelText("Audio file"), source);
    await waitFor(() => expect(api.analyzeKey).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("Analyzing original key…");
    expect(api.submitJob).not.toHaveBeenCalled();
    resolve({ original_key: "G major" });
    expect(await screen.findByText("Original key: G major")).toBeInTheDocument();
    expect(screen.getAllByText("Notes (major): G · A · B · C · D · E · F#")).toHaveLength(2);
    const pitch = screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" });
    await userEvent.clear(pitch);
    await userEvent.type(pitch, "2");
    expect(screen.getByText("Target key: A major")).toBeInTheDocument();
    expect(screen.getByText("Notes (major): A · B · C# · D · E · F# · G#")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("aborts stale requests and clears prior keys when source or mode changes", async () => {
    const first = Promise.withResolvers<api.KeyAnalysis>();
    const second = Promise.withResolvers<api.KeyAnalysis>();
    vi.mocked(api.analyzeKey)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    const input = screen.getByLabelText("Audio file");
    await userEvent.upload(input, new File(["first"], "first.wav", { type: "audio/wav" }));
    await waitFor(() => expect(api.analyzeKey).toHaveBeenCalledTimes(1));
    const firstSignal = vi.mocked(api.analyzeKey).mock.calls[0][1];
    await userEvent.upload(input, new File(["second"], "second.wav", { type: "audio/wav" }));
    await waitFor(() => expect(api.analyzeKey).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    second.resolve({ original_key: "F minor" });
    expect(await screen.findByText("Original key: F minor")).toBeInTheDocument();
    expect(screen.getAllByText("Notes (natural minor): F · G · Ab · Bb · C · Db · Eb")).toHaveLength(2);
    first.resolve({ original_key: "G major" });
    await Promise.resolve();
    expect(screen.queryByText("Original key: G major")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "From URL" }));
    expect(screen.queryByText("Original key: F minor")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Notes \(/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("debounces valid HTTP URLs and clears preview for an empty source", async () => {
    vi.useFakeTimers();
    try {
      render(() => <SubmitForm onSubmitted={vi.fn()} />);
      const input = screen.getByPlaceholderText("https://...");
      fireEvent.input(input, { target: { value: "ftp://example.com/audio" } });
      await vi.advanceTimersByTimeAsync(700);
      expect(api.analyzeKey).not.toHaveBeenCalled();
      fireEvent.input(input, { target: { value: "https://example.com/first" } });
      expect(screen.getByRole("status")).toHaveTextContent("Downloading audio and analyzing original key…");
      await vi.advanceTimersByTimeAsync(400);
      fireEvent.input(input, { target: { value: "https://example.com/second" } });
      await vi.advanceTimersByTimeAsync(599);
      expect(api.analyzeKey).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.analyzeKey).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Original key: Undetermined")).toBeInTheDocument();
      fireEvent.input(input, { target: { value: "" } });
      expect(screen.queryByText("Original key: Undetermined")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows analysis failures independently and retains the selected file after submission", async () => {
    vi.mocked(api.analyzeKey).mockRejectedValueOnce(new Error("Unsupported audio format"));
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 109, work_id: 9, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    const input = screen.getByLabelText("Audio file");
    await userEvent.upload(input, new File(["bad"], "bad.wav", { type: "audio/wav" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Key analysis: Unsupported audio format");
    expect(api.submitJob).not.toHaveBeenCalled();
    vi.mocked(api.analyzeKey).mockResolvedValueOnce({ original_key: "F major" });
    await userEvent.upload(input, new File(["good"], "good.wav", { type: "audio/wav" }));
    expect(await screen.findByText("Original key: F major")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(submitButton());
    await waitFor(() => expect(api.submitJob).toHaveBeenCalled());
    expect(await screen.findByText("Original key: F major")).toBeInTheDocument();
    expect(input.files).toHaveLength(1);
    expect(input.files?.[0]?.name).toBe("good.wav");
    expect(screen.getByRole("button", { name: "Download song" })).toBeInTheDocument();
  });

  it("retains every grouped selection and URL after submission", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 112, work_id: 12, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    const url = screen.getByLabelText("Track URL");
    await userEvent.type(url, "https://example.com/song");
    const groups = ["Outputs", "Mixes Build your own", "Cleanup", "Splits"];
    for (const name of groups) expect(screen.getByRole("group", { name, exact: true })).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    for (const checkbox of checkboxes) await userEvent.click(checkbox);
    await userEvent.click(submitButton());
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(url).toHaveValue("https://example.com/song");
    for (const checkbox of checkboxes) expect(checkbox).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" })).toHaveValue(0);
    expect(screen.getByRole("spinbutton", { name: "Tempo (% of original)" })).toHaveValue(100);
    expect(submitButton()).toBeEnabled();
  });

  it("retains a queued vocal-variant mix without selecting or previewing hidden prerequisites", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({ song_id: 114, work_id: 14, status: "queued", position: 1, progress: queuedProgress });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Track URL"), "https://example.com/lead");
    await userEvent.click(screen.getByText(/Vocal variants/));
    await userEvent.click(screen.getByRole("button", { name: "Female vocals" }));
    await userEvent.click(screen.getByRole("button", { name: "Instruments" }));
    await userEvent.click(screen.getByRole("button", { name: "Add mix" }));
    await userEvent.click(submitButton());
    await waitFor(() => expect(submitButton()).toBeEnabled());
    // The mix row survives submission; ingredients stay hidden from the preview.
    expect(screen.getByRole("button", { name: "Edit Female vocals + Instruments" })).toBeInTheDocument();
    expect(screen.getAllByText("Female vocals + Instruments", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByRole("checkbox", { name: "Split lead & backing vocals" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Extract vocals" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Extract instruments" })).not.toBeChecked();
  });

  it("keeps a mix rename made while a submission is pending", async () => {
    const deferred = Promise.withResolvers<api.SubmitResult>();
    vi.mocked(api.submitJob).mockReturnValueOnce(deferred.promise);
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Track URL"), "https://example.com/song");
    await userEvent.click(screen.getByRole("button", { name: "Drums" }));
    await userEvent.click(screen.getByRole("button", { name: "Bass" }));
    await userEvent.click(screen.getByRole("button", { name: "Add mix" }));
    await userEvent.click(submitButton());
    // While the POST is still pending, rename the queued mix.
    await userEvent.click(screen.getByRole("button", { name: "Edit Drums + Bass" }));
    await userEvent.type(screen.getByLabelText("Mix name for Drums + Bass"), " · v2");
    fireEvent.click(screen.getByRole("button", { name: "Save mix" }));
    deferred.resolve({ song_id: 121, work_id: 21, status: "queued", position: 1, progress: queuedProgress });
    await waitFor(() => expect(submitButton()).toBeEnabled());
    // The form itself shows the rename.
    expect(screen.getByRole("button", { name: "Edit Drums + Bass · v2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Drums + Bass", exact: true })).not.toBeInTheDocument();
  });
});
