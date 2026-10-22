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

  it("accepts fractional pitch and positive fractional tempo, then restores defaults", async () => {
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

    await waitFor(() => expect(pitch).toHaveValue(0));
    expect(tempo).toHaveValue(100);
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
    await waitFor(() => expect(pitch).toHaveValue(0));
    expect(tempo).toHaveValue(100);
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
    expect(screen.getByText("Tracks you'll get (1)")).toBeInTheDocument();
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

  it("shows analysis failures independently and clears preview after successful submission", async () => {
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
    await waitFor(() => expect(screen.queryByText("Original key: F major")).not.toBeInTheDocument());
    expect(screen.queryByText(/Target key:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Notes \(/)).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Download song" })).toBeInTheDocument();
  });

  it("submits every grouped option and Advanced cache without altering the API payload", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({ id: 12, status: "queued", position: 1 });
    render(() => <SubmitForm onSubmitted={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Track URL"), "https://example.com/song");
    const groups = ["Outputs", "Mixes", "Cleanup", "Splits"];
    for (const name of groups) expect(screen.getByRole("group", { name, exact: true })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Advanced · cache"));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(12);
    for (const checkbox of checkboxes) await userEvent.click(checkbox);
    await userEvent.click(submitButton());
    expect(api.submitJob).toHaveBeenCalledWith({
      url: "https://example.com/song",
      file: undefined,
      options: {
        extract_vocals: true, extract_instruments: true,
        mix_female_instruments: true, mix_male_instruments: true, mix_backing_instruments: true,
        decrowd: true, decrowd_vocals: true, dereverb: true,
        genders: true, lead_backing: true, drums: true, no_cache: true,
        pitch_semitones: 0, tempo_percent: 100,
      },
    });
  });
});
