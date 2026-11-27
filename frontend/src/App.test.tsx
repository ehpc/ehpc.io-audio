import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import type { JobDTO, SongDetail, SongSummary, SubmitResult } from "./api";
import { registerMediaSession } from "./lib/mediaSession";

vi.mock("./api", async original => ({
  ...await original<typeof api>(),
  getCurrentSong: vi.fn(), getSong: vi.fn(), getJob: vi.fn(), listSongs: vi.fn(),
  recordSongOpen: vi.fn(), deleteSong: vi.fn(), retryJob: vi.fn(),
  subscribeToJob: vi.fn(), submitJob: vi.fn(), analyzeKey: vi.fn(),
}));
vi.mock("./AuthProvider", () => ({ useAuth: () => ({
  profile: () => ({ id: "user-1", email: "listener@example.test", is_admin: false, invite_limit: 0, invites: [] }),
  refresh: vi.fn(), logout: vi.fn(),
}) }));
vi.mock("./ProfileView", () => ({ default: () => <section>Profile contents</section> }));

const progress: api.JobProgress = { steps: ["source", "analysis", "export"], current: null };
const song = (id: number, title: string, overrides: Partial<SongSummary> = {}): SongSummary => ({
  id, title, source_type: "url", source_value: `https://example.test/${id}`, created_at: id,
  open_count: 0, status: "done", has_original: true, original_key: null, original_work_id: id + 100,
  latest_work_id: id + 100, active_work_id: null, active_work_ids: [],
  availability: { audio: true, karaoke: false, lyrics: false, pitched_lyrics: false }, ...overrides,
});
const work = (id: number, title: string, overrides: Partial<JobDTO> = {}): JobDTO => ({
  id, song_id: id === 101 ? 1 : id === 102 ? 2 : 1, title, source_type: "url", source_value: `https://example.test/${id}`, status: "done", position: null,
  progress, options: { extract_vocals: false, extract_instruments: false, extract_lyrics: false,
    detect_pitch: false, extract_pitched_lyrics: false, mixes: [], decrowd: false, decrowd_vocals: false,
    dereverb: false, genders: false, lead_backing: false, drums: false, pitch_semitones: 0, tempo_percent: 100 },
  original_key: null, output_key: null, result_revision: null, manifest: [], transcript: null,
  lyric_pitch_lines: null, error_message: null, created_at: 1, has_original: true, has_pitch_vocals: false,
  ...overrides,
});
const detail = (summary: SongSummary, revision = "v1"): SongDetail => ({
  summary, variants: [{ pitch_semitones: 0, tempo_percent: 100, karaoke_work_id: null, karaoke_revision: null,
    lyrics_work_id: null, lyrics_revision: null, pitched_lyrics_work_id: null, pitched_lyrics_revision: null,
    outputs: [{ identity: "vocals", label: "vocals", display_name: "Vocals", work_id: summary.original_work_id!, revision,
      manifest: { label: "vocals", filename: "vocals.mp3", download_name: "vocals.mp3", duration_s: 10, size_bytes: 100 } }],
  }],
});
const first = song(1, "Harbor song");
const second = song(2, "Other song");

let scrollIntoViewDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  vi.clearAllMocks();
  vi.mocked(api.getCurrentSong).mockResolvedValue(null);
  vi.mocked(api.listSongs).mockResolvedValue([first, second]);
  vi.mocked(api.getSong).mockImplementation(async id => detail(id === first.id ? first : second));
  vi.mocked(api.getJob).mockImplementation(async id => work(id, id === 101 ? first.title! : second.title!));
  vi.mocked(api.recordSongOpen).mockImplementation(async id => ({ id, open_count: 1 }));
  vi.mocked(api.subscribeToJob).mockReturnValue(() => {});
  vi.mocked(api.analyzeKey).mockResolvedValue({ original_key: null });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (scrollIntoViewDescriptor) Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

it("keeps paired playback together while stopping unrelated audio", () => {
  render(() => <App />);
  const master = document.createElement("audio"), vocal = document.createElement("audio"), other = document.createElement("audio");
  document.body.append(master, vocal, other);
  try {
    const playing = new Map([master, vocal, other].map(audio => [audio, false]));
    for (const audio of [master, vocal, other]) {
      Object.defineProperty(audio, "paused", { configurable: true, get: () => !playing.get(audio) });
      vi.spyOn(audio, "pause").mockImplementation(() => { playing.set(audio, false); });
    }
    const unregister = registerMediaSession(master, vocal);
    playing.set(master, true); fireEvent.play(master);
    playing.set(vocal, true); fireEvent.play(vocal);
    expect(master.paused).toBe(false);
    expect(vocal.paused).toBe(false);
    playing.set(other, true); fireEvent.play(other);
    expect(master.paused).toBe(true);
    expect(vocal.paused).toBe(true);
    unregister();
    playing.set(master, true); fireEvent.play(master);
    expect(other.paused).toBe(true);
  } finally { master.remove(); vocal.remove(); other.remove(); }
});

it("promotes only acknowledged opens and preserves them through stale library responses", async () => {
  const oldListing = Promise.withResolvers<SongSummary[]>();
  const acknowledgement = Promise.withResolvers<{ id: number; open_count: number }>();
  vi.mocked(api.listSongs).mockResolvedValueOnce([second, first]).mockReturnValueOnce(oldListing.promise);
  vi.mocked(api.recordSongOpen).mockReturnValueOnce(acknowledgement.promise);
  render(() => <App />);
  const history = await screen.findByRole("region", { name: "History" });
  const titles = () => within(history).getAllByRole("button").filter(button => ["Harbor song", "Other song"].includes(button.textContent ?? "")).map(button => button.textContent);
  await waitFor(() => expect(titles()).toEqual(["Other song", "Harbor song"]));
  await userEvent.click(within(history).getByRole("button", { name: "Harbor song", exact: true }));
  expect(titles()).toEqual(["Other song", "Harbor song"]);
  acknowledgement.resolve({ id: 1, open_count: 3 });
  await waitFor(() => expect(titles()).toEqual(["Harbor song", "Other song"]));
  oldListing.resolve([second, first]);
  await oldListing.promise;
  expect(titles()).toEqual(["Harbor song", "Other song"]);
});

it("opens a song without promoting it when recording its open fails", async () => {
  vi.mocked(api.recordSongOpen).mockRejectedValueOnce(new Error("offline"));
  render(() => <App />);
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song", exact: true }));
  expect(await screen.findByRole("heading", { name: "Harbor song", level: 2 })).toBeVisible();
  const history = screen.getByRole("region", { name: "History" });
  expect(within(history).getAllByRole("listitem").map(row => row.textContent)).toEqual([expect.stringContaining("Other song"), expect.stringContaining("Harbor song")]);
});

it("restores the latest failed addition on reload while keeping completed downloads and retry", async () => {
  const saved = song(1, "Harbor song", { status: "done", latest_work_id: 205 });
  vi.mocked(api.getCurrentSong).mockResolvedValue(saved);
  vi.mocked(api.getSong).mockResolvedValue(detail(saved));
  vi.mocked(api.getJob).mockImplementation(async id => id === 205
    ? work(205, "Harbor song", { status: "failed", error_message: "Separation failed" }) : work(id, "Harbor song"));
  vi.mocked(api.retryJob).mockRejectedValueOnce(new Error("Queue unavailable"))
    .mockResolvedValueOnce({ song_id: 1, work_id: 206, status: "queued", position: 1, progress });
  render(() => <App />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Separation failed");
  expect(await screen.findByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/101/results/vocals?revision=v1");
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Queue unavailable")).toBeVisible();
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.retryJob).toHaveBeenLastCalledWith(205));
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toBeVisible();
});

it("keeps cached downloads visible and reports a failed same-song refresh", async () => {
  vi.mocked(api.getCurrentSong).mockResolvedValue(first);
  vi.mocked(api.getSong).mockResolvedValueOnce(detail(first)).mockRejectedValueOnce(new Error("offline"));
  render(() => <App />);
  const download = await screen.findByRole("link", { name: "Download vocals.mp3" });
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song", exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  expect(download).toBeVisible();
});

it("ignores a late song detail after a newer selection", async () => {
  const pending = Promise.withResolvers<SongDetail>();
  vi.mocked(api.getSong).mockImplementation(id => id === 1 ? pending.promise : Promise.resolve(detail(second, "other")));
  render(() => <App />);
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Other song", exact: true }));
  expect(await screen.findByRole("heading", { name: "Other song", level: 2 })).toBeVisible();
  pending.resolve(detail(first, "late"));
  await pending.promise;
  expect(screen.queryByRole("heading", { name: "Harbor song", level: 2 })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/102/results/vocals?revision=other");
});

it("does not restore a deleted selection after its detail arrives", async () => {
  const pending = Promise.withResolvers<SongDetail>();
  vi.mocked(api.getSong).mockReturnValueOnce(pending.promise);
  vi.mocked(api.deleteSong).mockResolvedValue(undefined);
  render(() => <App />);
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Delete Harbor song" }));
  await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete track" }));
  await waitFor(() => expect(api.deleteSong).toHaveBeenCalledWith(1));
  pending.resolve(detail(first));
  await pending.promise;
  expect(screen.queryByRole("heading", { name: "Harbor song", level: 2 })).not.toBeInTheDocument();
});

it("watches every active physical work and ignores a stale disconnect snapshot", async () => {
  const active = song(1, "Harbor song", { status: "running", latest_work_id: 205, active_work_id: 205, active_work_ids: [205, 206] });
  const pending = Promise.withResolvers<JobDTO>();
  vi.mocked(api.getCurrentSong).mockResolvedValue(active);
  vi.mocked(api.getSong).mockResolvedValue(detail(active));
  vi.mocked(api.getJob).mockImplementation(async id => id === 205 ? work(205, "Harbor song", { status: "queued" }) : work(id, "Harbor song"));
  render(() => <App />);
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledTimes(2));
  const subscription = vi.mocked(api.subscribeToJob).mock.calls.find(([id]) => id === 205)!;
  vi.mocked(api.getJob).mockReturnValueOnce(pending.promise);
  subscription[2]!();
  subscription[1](work(205, "Harbor song", { status: "running" }));
  pending.resolve(work(205, "Harbor song", { status: "queued" }));
  await pending.promise;
  expect(document.querySelector(".job-dock")).toHaveTextContent("Processing audio");
  expect(await screen.findByRole("link", { name: "Download vocals.mp3" })).toBeVisible();
});

it("refreshes a previously running work from the server when the selected song is reopened", async () => {
  const running = song(1, "Harbor song", { status: "running", latest_work_id: 205, active_work_id: 205, active_work_ids: [205] });
  const completed = song(1, "Harbor song", { latest_work_id: 205 });
  let finished = false;
  vi.mocked(api.getCurrentSong).mockResolvedValue(running);
  vi.mocked(api.listSongs).mockImplementation(async () => [finished ? completed : running]);
  vi.mocked(api.getSong).mockImplementation(async () => detail(finished ? completed : running));
  vi.mocked(api.getJob).mockImplementation(async id => id === 205
    ? work(205, "Harbor song", { status: finished ? "done" : "running" })
    : work(id, "Harbor song"));
  render(() => <App />);
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledWith(205, expect.any(Function), expect.any(Function)));
  vi.mocked(api.subscribeToJob).mock.calls.find(([id]) => id === 205)![1](work(205, "Harbor song", { status: "running" }));
  expect(await screen.findByText("Processing: Harbor song")).toBeVisible();
  finished = true;
  await userEvent.click(screen.getByRole("button", { name: "Harbor song", exact: true }));
  await waitFor(() => expect(screen.queryByText("Processing: Harbor song")).not.toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toBeVisible();
});

it("adopts a canonical song after an SSE membership merge without interrupting unrelated work", async () => {
  const unrelated = song(3, "Background song", { status: "running", latest_work_id: 301, active_work_id: 301, active_work_ids: [301] });
  const young = song(2, "New alias", { status: "running", latest_work_id: 202, active_work_id: 202, active_work_ids: [202] });
  const canonical = song(1, "Canonical song", { latest_work_id: 202, active_work_id: 202, active_work_ids: [202] });
  vi.mocked(api.getCurrentSong).mockResolvedValue(unrelated);
  vi.mocked(api.listSongs).mockResolvedValue([young, unrelated, canonical]);
  vi.mocked(api.getSong).mockImplementation(async id => {
    if (id === 3) return detail(unrelated);
    if (id === 2) return detail(young);
    if (id === 1) return detail(canonical, "merged");
    throw new Error(`Unknown song ${id}`);
  });
  vi.mocked(api.getJob).mockImplementation(async id => work(id, id === 301 ? "Background song" : "New alias",
    { song_id: id === 301 ? 3 : 2, status: "running" }));
  render(() => <App />);
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledWith(301, expect.any(Function), expect.any(Function)));
  await userEvent.click(await screen.findByRole("button", { name: "New alias", exact: true }));
  await screen.findByRole("heading", { name: "New alias", level: 2 });
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledWith(202, expect.any(Function), expect.any(Function)));
  const merge = vi.mocked(api.subscribeToJob).mock.calls.find(([id]) => id === 202)![1];
  merge(work(202, "New alias", { song_id: 1, status: "running" }));
  expect(await screen.findByRole("heading", { name: "Canonical song", level: 2 })).toBeVisible();
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/101/results/vocals?revision=merged");
  expect(api.recordSongOpen).not.toHaveBeenCalledWith(1);
  const background = vi.mocked(api.subscribeToJob).mock.calls.find(([id]) => id === 301)![1];
  background(work(301, "Background song", { song_id: 3, status: "done" }));
  await waitFor(() => expect(document.querySelector(".job-dock")).toHaveTextContent("Complete"));
  expect(screen.getByRole("heading", { name: "Canonical song", level: 2 })).toBeVisible();
});

it("follows a selected completed alias merged into an older background song and adds outputs there", async () => {
  const older = song(99, "Canonical source", { status: "running", latest_work_id: 199, active_work_id: 199, active_work_ids: [199] });
  const selected = song(100, "Selected source", { latest_work_id: 200, original_work_id: 200 });
  const canonical = song(99, "Canonical source", { latest_work_id: 200, original_work_id: 200 });
  let merged = false;
  vi.mocked(api.getCurrentSong).mockResolvedValue(older);
  vi.mocked(api.listSongs).mockImplementation(async () => merged ? [canonical] : [selected, older]);
  vi.mocked(api.getSong).mockImplementation(async id => {
    if (id === 100 && merged) throw new api.AuthHttpError(404, "song not found");
    if (id === 100) return detail(selected);
    if (id === 99) return detail(merged ? canonical : older, merged ? "merged" : "v1");
    throw new Error(`Unexpected song ${id}`);
  });
  vi.mocked(api.getJob).mockImplementation(async id => work(id, "Selected source", {
    song_id: id === 200 && !merged ? 100 : 99, status: id === 199 && !merged ? "running" : "done",
  }));
  vi.mocked(api.submitJob).mockResolvedValue({ song_id: 99, work_id: null, status: "done", position: null, progress: null });
  render(() => <App />);
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledWith(199, expect.any(Function), expect.any(Function)));
  await userEvent.click(await screen.findByRole("button", { name: "Selected source", exact: true }));
  expect(await screen.findByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/200/results/vocals?revision=v1");
  await userEvent.click(screen.getByRole("button", { name: "Add outputs", exact: true }));
  expect(screen.getByText(/Adding outputs to Selected source/)).toBeVisible();
  merged = true;
  vi.mocked(api.subscribeToJob).mock.calls.find(([id]) => id === 199)![1](work(199, "Canonical source", { song_id: 99, status: "done" }));
  expect(await screen.findByRole("heading", { name: "Canonical source", level: 2 })).toBeVisible();
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/200/results/vocals?revision=merged");
  expect(screen.getByText(/Adding outputs to Canonical source/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /Download song|Process audio/, exact: true }));
  await waitFor(() => expect(api.submitJob).toHaveBeenCalledWith(expect.objectContaining({ file: undefined, url: undefined }), 99));
  expect(screen.getByText(/Adding outputs to Canonical source/)).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Track URL" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Download song|Process audio/, exact: true }));
  await waitFor(() => expect(api.submitJob).toHaveBeenCalledTimes(2));
  expect(api.submitJob).toHaveBeenLastCalledWith(expect.objectContaining({ file: undefined, url: undefined }), 99);
});

it("does not replace a newer selection when an older submission completes", async () => {
  const pending = Promise.withResolvers<SubmitResult>();
  vi.mocked(api.submitJob).mockReturnValueOnce(pending.promise);
  render(() => <App />);
  fireEvent.input(screen.getByLabelText("Track URL"), { target: { value: "https://example.test/new" } });
  await userEvent.click(screen.getByRole("button", { name: "Download song", exact: true }));
  await userEvent.click(await screen.findByRole("button", { name: "Other song", exact: true }));
  expect(await screen.findByRole("heading", { name: "Other song", level: 2 })).toBeVisible();
  pending.resolve({ song_id: 1, work_id: 300, status: "queued", position: 1, progress });
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledWith(300, expect.any(Function), expect.any(Function)));
  expect(screen.getByRole("heading", { name: "Other song", level: 2 })).toBeVisible();
});

it("does not increment opens when switching workspace and profile", async () => {
  vi.mocked(api.getCurrentSong).mockResolvedValue(first);
  render(() => <App />);
  await screen.findByRole("heading", { name: "Harbor song", level: 2 });
  await userEvent.click(screen.getByRole("button", { name: "Profile", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Workspace", exact: true }));
  expect(api.recordSongOpen).not.toHaveBeenCalled();
});
