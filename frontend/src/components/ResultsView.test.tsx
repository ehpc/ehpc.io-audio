import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import type { SongDetail, SongOutputRef, SongVariant } from "~/api";
import * as api from "~/api";
import ResultsView from "./ResultsView";

const revisions = new Map<number, string>();
vi.mock("~/api", async importOriginal => ({ ...(await importOriginal<typeof import("~/api")>()), getJob: vi.fn(async (id: number) => ({
  id, song_id: 1, status: "done", result_revision: revisions.get(id) ?? null, original_key: "C major",
  manifest: [], transcript: null, lyric_pitch_lines: null, has_pitch_vocals: false,
  options: { pitch_semitones: id === 22 ? 2 : 0, tempo_percent: 100 },
  pitched_lyrics: [{ label: "lead", text: id === 22 ? "  B♭4\n[00:01] 二\n" : "  C4\n[00:01] Un\n", wide_characters: "二" }],
  pitch: { version: 1, model: "fixture", source_duration_s: 60, duration_s: 60, pitch_shift_semitones: 0,
    tempo_percent: 100, timestamp_reference: "output", pitch_reference: "output", word_alignment: null,
    words: [], tracks: [{ label: "vocals", notes: [] }] },
})) }));
vi.mock("./AudioMetadata", () => ({ default: () => null }));

const output = (identity: string, work_id: number, revision: string): SongOutputRef => ({ identity, label: identity, display_name: identity, work_id, revision, manifest: { label: identity, filename: `${identity}.mp3`, download_name: `${identity}.mp3`, duration_s: 60, size_bytes: 100 } });
const variant = (pitch: number, outputs: SongOutputRef[], karaoke: number | null = null): SongVariant => ({ pitch_semitones: pitch, tempo_percent: 100, outputs, karaoke_work_id: karaoke, karaoke_revision: karaoke ? `k${karaoke}` : null, lyrics_work_id: null, lyrics_revision: null, pitched_lyrics_work_id: null, pitched_lyrics_revision: null });
const song: SongDetail = { summary: { id: 1, title: "Song", source_type: "upload", source_value: "song.wav", created_at: 1, open_count: 1, status: "done", has_original: true, original_key: "C major", original_work_id: 4, latest_work_id: 22, active_work_id: null, active_work_ids: [], availability: { audio: true, karaoke: true, lyrics: false, pitched_lyrics: false } }, variants: [variant(0, [output("vocals", 10, "v10"), output("instruments", 11, "i11")], 12), variant(2, [output("vocals", 20, "v20"), output("instruments", 21, "i21")], 22)] };

beforeEach(() => {
  revisions.clear();
  revisions.set(12, "k12");
  revisions.set(22, "k22");
  vi.mocked(api.getJob).mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

it("changes each stem independently and uses its own physical work and revision", async () => {
  render(() => <ResultsView detail={song} onReset={vi.fn()} refreshToken={0} onStaleDetail={vi.fn()} />);
  expect(await screen.findByRole("link", { name: "Download pitch JSON" })).toHaveAttribute("href", "/api/jobs/12/pitch?revision=k12");
  expect(await screen.findAllByText("Source key: C major")).toHaveLength(2);
  const vocals = screen.getByRole("combobox", { name: "vocals version" });
  const instruments = screen.getByRole("combobox", { name: "instruments version" });
  fireEvent.change(vocals, { target: { value: "2:100" } });
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/20/results/vocals?revision=v20");
  expect(screen.getByRole("link", { name: "Download instruments.mp3" })).toHaveAttribute("href", "/api/jobs/11/results/instruments?revision=i11");
  expect(instruments).toHaveValue("0:100");
  expect(screen.getByRole("combobox", { name: "Karaoke version" })).toHaveValue("0:100");
  expect(screen.getByRole("link", { name: "Download original" })).toHaveAttribute("href", "/api/jobs/4/original");
  fireEvent.change(screen.getByRole("combobox", { name: "Karaoke version" }), { target: { value: "2:100" } });
  expect(vocals).toHaveValue("2:100");
  expect(await screen.findByRole("link", { name: "Download pitch JSON" })).toHaveAttribute("href", "/api/jobs/22/pitch?revision=k22");
});

it("keeps an explicitly chosen pitched-lyrics version when karaoke changes independently", async () => {
  const detail: SongDetail = { ...song, variants: song.variants.map(item => ({
    ...item, pitched_lyrics_work_id: item.karaoke_work_id, pitched_lyrics_revision: item.karaoke_revision,
  })) };
  render(() => <ResultsView detail={detail} onReset={vi.fn()} refreshToken={0} onStaleDetail={vi.fn()} />);
  await screen.findByRole("region", { name: "Aligned pitch and lyric text" });
  const pitched = screen.getByRole("combobox", { name: "Pitched lyrics version" });
  const karaoke = screen.getByRole("combobox", { name: "Karaoke version" });
  fireEvent.change(pitched, { target: { value: "2:100" } });
  await vi.waitFor(() => expect(screen.getByRole("region", { name: "Aligned pitch and lyric text" }).textContent).toBe("  B♭4\n[00:01] 二\n"));
  fireEvent.change(karaoke, { target: { value: "2:100" } });
  fireEvent.change(karaoke, { target: { value: "0:100" } });
  expect(pitched).toHaveValue("2:100");
  expect(screen.getByRole("region", { name: "Aligned pitch and lyric text" }).textContent).toBe("  B♭4\n[00:01] 二\n");
});

it("shows the actual remaining version when the selected stem variant disappears", () => {
  const third = variant(3, [output("vocals", 30, "v30")]);
  const [detail, setDetail] = createSignal({ ...song, variants: [...song.variants, third] });
  render(() => <ResultsView detail={detail()} onReset={vi.fn()} refreshToken={0} onStaleDetail={vi.fn()} />);
  const vocals = screen.getByRole("combobox", { name: "vocals version" });
  fireEvent.change(vocals, { target: { value: "2:100" } });
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/20/results/vocals?revision=v20");
  setDetail({ ...song, variants: [song.variants[0], third] });
  expect(vocals).toHaveValue("0:100");
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/10/results/vocals?revision=v10");
});

it("uses the song's verified source key for audio-only results even when the original work has no key", async () => {
  const current: SongDetail = {
    summary: { ...song.summary, original_key: "D major", availability: { audio: true, karaoke: false, lyrics: false, pitched_lyrics: false } },
    variants: [variant(0, [output("vocals", 10, "v10")])],
  };
  const load = vi.mocked(api.getJob).getMockImplementation()!;
  vi.mocked(api.getJob).mockResolvedValueOnce({ ...await load(4), original_key: null });
  render(() => <ResultsView detail={current} onReset={vi.fn()} refreshToken={0} onStaleDetail={vi.fn()} />);
  expect(await screen.findByText("Original key: D major")).toBeVisible();
  expect(screen.getByText("Source key: D major")).toBeVisible();
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/10/results/vocals?revision=v10");
});

it("keeps completed downloads visible while another work runs or fails", async () => {
  const [detail, setDetail] = createSignal(song);
  render(() => <ResultsView detail={detail()} onReset={vi.fn()} refreshToken={0} onStaleDetail={vi.fn()} />);
  const vocals = screen.getByRole("link", { name: "Download vocals.mp3" });
  expect(vocals).toHaveAttribute("href", "/api/jobs/10/results/vocals?revision=v10");
  setDetail({ ...song, summary: { ...song.summary, status: "running", latest_work_id: 99, active_work_id: 99, active_work_ids: [99] } });
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/10/results/vocals?revision=v10");
  setDetail({ ...song, summary: { ...song.summary, status: "failed", latest_work_id: 99, active_work_id: null, active_work_ids: [] } });
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/10/results/vocals?revision=v10");
});

it("reloads a changed physical work revision without losing existing output links", async () => {
  const [detail, setDetail] = createSignal(song);
  render(() => <ResultsView detail={detail()} onReset={vi.fn()} refreshToken={0} onStaleDetail={vi.fn()} />);
  expect(await screen.findByRole("link", { name: "Download pitch JSON" })).toHaveAttribute("href", "/api/jobs/12/pitch?revision=k12");
  revisions.set(12, "regenerated");
  setDetail({ ...song, variants: [{ ...song.variants[0], karaoke_revision: "regenerated" }, song.variants[1]] });
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/10/results/vocals?revision=v10");
  await vi.waitFor(() => expect(screen.getByRole("link", { name: "Download pitch JSON" })).toHaveAttribute("href", "/api/jobs/12/pitch?revision=regenerated"));
  expect(vi.mocked(api.getJob).mock.calls.filter(([id]) => id === 12)).toHaveLength(2);
});

it("reports a failed lazy work load without removing completed audio", async () => {
  vi.mocked(api.getJob).mockRejectedValueOnce(new Error("analysis unavailable"));
  render(() => <ResultsView detail={song} onReset={vi.fn()} refreshToken={0} onStaleDetail={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("analysis unavailable");
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/10/results/vocals?revision=v10");
});

it("discards a newer work generation until song detail catches up", async () => {
  const pending = Promise.withResolvers<api.JobDTO>();
  const load = vi.mocked(api.getJob).getMockImplementation()!;
  vi.mocked(api.getJob).mockReturnValueOnce(pending.promise);
  const [detail, setDetail] = createSignal(song);
  const stale = vi.fn();
  render(() => <ResultsView detail={detail()} onReset={vi.fn()} refreshToken={0} onStaleDetail={stale} />);
  revisions.set(12, "new-generation");
  pending.resolve(await load(12));
  await vi.waitFor(() => expect(stale).toHaveBeenCalledWith(song.summary.id));
  expect(screen.queryByRole("link", { name: "Download pitch JSON" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Download vocals.mp3" })).toHaveAttribute("href", "/api/jobs/10/results/vocals?revision=v10");
  setDetail({ ...song, variants: [{ ...song.variants[0], karaoke_revision: "new-generation" }, song.variants[1]] });
  expect(await screen.findByRole("link", { name: "Download pitch JSON" })).toHaveAttribute("href", "/api/jobs/12/pitch?revision=new-generation");
});

it("retries a failed lazy load only when the user explicitly refreshes the song", async () => {
  vi.mocked(api.getJob).mockRejectedValueOnce(new Error("analysis unavailable"));
  const [refreshToken, setRefreshToken] = createSignal(0);
  render(() => <ResultsView detail={song} onReset={vi.fn()} refreshToken={refreshToken()} onStaleDetail={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("analysis unavailable");
  expect(vi.mocked(api.getJob).mock.calls.filter(([id]) => id === 12)).toHaveLength(1);
  setRefreshToken(1);
  expect(await screen.findByRole("link", { name: "Download pitch JSON" })).toHaveAttribute("href", "/api/jobs/12/pitch?revision=k12");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(vi.mocked(api.getJob).mock.calls.filter(([id]) => id === 12)).toHaveLength(2);
});
