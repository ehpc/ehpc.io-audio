import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "~/api";
import SubmitForm from "./SubmitForm";

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return { ...actual, submitJob: vi.fn(), analyzeKey: vi.fn() };
});

const submitButton = () => screen.getByRole("button", { name: /download song|process audio/i });

describe("SubmitForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: null });
  });

  it("blocks submit and shows an error when neither URL nor file is given", async () => {
    const onSubmitted = vi.fn();
    render(() => <SubmitForm onSubmitted={onSubmitted} />);

    await userEvent.click(submitButton());

    expect(screen.getByText(/provide a url or choose a file/i)).toBeInTheDocument();
    expect(api.submitJob).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it.each([
    ["song.mp3", "audio/mpeg"],
    ["song.MP3", "application/octet-stream"],
    ["song.mp3", ""],
    ["song.wav", "application/octet-stream"],
  ])("analyzes and submits %s reported as %s without changing the file", async (name, type) => {
    vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: "C major" });
    vi.mocked(api.submitJob).mockResolvedValue({ id: 13, status: "queued", position: 1 });
    const onSubmitted = vi.fn();
    render(() => <SubmitForm onSubmitted={onSubmitted} />);
    await userEvent.click(screen.getByRole("button", { name: "Upload audio" }));
    const source = new File(["provider audio"], name, { type });
    await userEvent.upload(screen.getByLabelText("Audio file"), source);
    expect(await screen.findByText(`Selected: ${name}`)).toBeInTheDocument();
    expect(await screen.findByText("Original key: C major")).toBeInTheDocument();
    expect(api.analyzeKey).toHaveBeenCalledWith({ file: source }, expect.any(AbortSignal));
    await userEvent.click(submitButton());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(api.submitJob).toHaveBeenCalledWith(expect.objectContaining({ file: source, url: undefined }));
    expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ source_type: "upload", source_value: name }));
  });

  it("retains fractional pitch and positive fractional tempo after submission", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({
      id: 7,
      status: "queued",
      position: 1,
    });
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
    vi.mocked(api.submitJob).mockResolvedValue({ id: 10, status: "queued", position: 1 });
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
  it("keeps the URL and selections after success and submits later edits as a new snapshot", async () => {
    const pending = Promise.withResolvers<{ id: number; status: "queued"; position: number }>();
    vi.mocked(api.submitJob).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      id: 11, status: "queued", position: 1,
    });
    const onSubmitted = vi.fn();
    render(() => <SubmitForm onSubmitted={onSubmitted} />);
    const url = screen.getByLabelText("Track URL");
    fireEvent.input(url, { target: { value: "https://example.com/song" } });
    const vocals = screen.getByRole("checkbox", { name: "Extract vocals", exact: true });
    await userEvent.click(vocals);
    await userEvent.click(screen.getByText("Advanced · cache"));
    const cache = screen.getByRole("checkbox", { name: /reprocess from scratch/i });
    await userEvent.click(cache);
    const pitch = screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" });
    const tempo = screen.getByRole("spinbutton", { name: "Tempo (% of original)" });
    fireEvent.input(pitch, { target: { value: "-1.25" } });
    fireEvent.input(tempo, { target: { value: "119.5" } });
    await userEvent.click(screen.getByRole("tab", { name: "Review" }));

    await userEvent.click(submitButton());
    expect(api.submitJob).toHaveBeenLastCalledWith({
      url: "https://example.com/song", file: undefined,
      options: expect.objectContaining({ extract_vocals: true, no_cache: true, pitch_semitones: -1.25, tempo_percent: 119.5 }),
    });
    fireEvent.input(url, { target: { value: "https://example.com/edited" } });
    fireEvent.input(pitch, { target: { value: "2.5" } });
    pending.resolve({ id: 10, status: "queued", position: 1 });
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(onSubmitted.mock.calls[0][0]).toEqual(expect.objectContaining({
      source_value: "https://example.com/song",
      options: expect.objectContaining({ pitch_semitones: -1.25, tempo_percent: 119.5, extract_vocals: true, no_cache: true }),
    }));
    expect(url).toHaveValue("https://example.com/edited");
    expect(pitch).toHaveValue(2.5);
    expect(tempo).toHaveValue(119.5);
    expect(vocals).toBeChecked();
    expect(cache).toBeChecked();
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(submitButton());
    expect(api.submitJob).toHaveBeenCalledTimes(2);
    expect(api.submitJob).toHaveBeenLastCalledWith(expect.objectContaining({
      url: "https://example.com/edited",
      options: expect.objectContaining({ pitch_semitones: 2.5, tempo_percent: 119.5, extract_vocals: true, no_cache: true }),
    }));
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


  it("steps pitch and tempo from defaults and fractional entries, updates previews, and submits the adjusted values", async () => {
    vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: "C major" });
    vi.mocked(api.submitJob).mockResolvedValue({ id: 8, status: "queued", position: 1 });
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
    expect(api.submitJob).not.toHaveBeenCalled();
    await userEvent.click(submitButton());
    expect(api.submitJob).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ pitch_semitones: -1.25, tempo_percent: 119.5 }),
    }));
    await waitFor(() => expect(api.submitJob).toHaveBeenCalled());
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

  it("has accessible extraction controls and predicts original-only by default", async () => {
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    expect(screen.getByText("Tracks and files you'll get (1)")).toBeInTheDocument();
    const extract = screen.getByRole("checkbox", { name: "Extract vocals" });
    expect(extract).not.toBeChecked();
    await userEvent.click(screen.getByText("Extract vocals"));
    expect(extract).toBeChecked();
    expect(screen.getByRole("button", { name: "Process audio" })).toBeInTheDocument();
    expect(screen.getByText("vocals", { exact: true })).toBeInTheDocument();
    await userEvent.click(extract);
    await userEvent.click(screen.getByRole("checkbox", { name: "Female vocals + instruments" }));
    expect(screen.getByText("female-instruments", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("vocals-female", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("instruments", { exact: true })).not.toBeInTheDocument();
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

  it("submits a lyrics-only request without selecting an audio stem", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({ id: 18, status: "queued", position: 1 });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Track URL"), "https://example.com/song");
    await userEvent.click(screen.getByRole("checkbox", { name: "Extract lyrics", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Process audio" }));
    expect(api.submitJob).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        extract_lyrics: true,
        extract_vocals: false,
        extract_instruments: false,
        mix_female_instruments: false,
        pitch_semitones: 0,
        tempo_percent: 100,
      }),
    }));
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
    expect(api.analyzeKey).toHaveBeenCalledWith({ file: source }, expect.any(AbortSignal));
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
      expect(vi.mocked(api.analyzeKey).mock.calls[0][0]).toEqual({ url: "https://example.com/second" });
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
    vi.mocked(api.submitJob).mockResolvedValue({ id: 9, status: "queued", position: 1 });
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

  it("retains every grouped selection, Advanced cache, and URL after submission", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({ id: 12, status: "queued", position: 1 });
    const onSubmitted = vi.fn();
    render(() => <SubmitForm onSubmitted={onSubmitted} />);
    const url = screen.getByLabelText("Track URL");
    await userEvent.type(url, "https://example.com/song");
    const groups = ["Outputs", "Mixes", "Cleanup", "Splits"];
    for (const name of groups) expect(screen.getByRole("group", { name, exact: true })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Advanced · cache"));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(14);
    for (const checkbox of checkboxes) await userEvent.click(checkbox);
    await userEvent.click(submitButton());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(url).toHaveValue("https://example.com/song");
    for (const checkbox of checkboxes) expect(checkbox).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Pitch shift (semitones)" })).toHaveValue(0);
    expect(screen.getByRole("spinbutton", { name: "Tempo (% of original)" })).toHaveValue(100);
    expect(submitButton()).toBeEnabled();
  });

  it("submits the lead mix without selecting or previewing hidden prerequisites", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({ id: 14, status: "queued", position: 1 });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Track URL"), "https://example.com/lead");
    await userEvent.click(screen.getByRole("checkbox", { name: "Lead vocals + instruments", exact: true }));
    expect(screen.getByText("lead-instruments", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Split lead & backing vocals" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Extract vocals" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Extract instruments" })).not.toBeChecked();
    await userEvent.click(submitButton());
    expect(api.submitJob).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        mix_lead_instruments: true, lead_backing: false, extract_vocals: false, extract_instruments: false,
      }),
    }));
  });
});
