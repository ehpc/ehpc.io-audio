import { afterEach, expect, it, vi } from "vitest";
import {
  AuthHttpError, adminCacheRegenerations, authLogout, authMe, authStart, authVerify,
  getStatus, lyricsDownloadUrl, lyricsJsonDownloadUrl, onUnauthorized, originalUrl,
  pitchDownloadUrl, pitchVocalsUrl, pitchedLyricsDownloadUrl, playbackUrl, regenerateAdminCache,
  resultUrl, submitJob, subscribeToJob, type SeparationOptions,
} from "~/api";

const defaultOptions: SeparationOptions = {
  extract_vocals: false,
  extract_instruments: false,
  extract_lyrics: false,
  detect_pitch: false,
  extract_pitched_lyrics: false,
  mixes: [],
  decrowd: false,
  decrowd_vocals: false,
  dereverb: false,
  genders: false,
  lead_backing: false,
  drums: false,
  pitch_semitones: 0,
  tempo_percent: 100,
};

afterEach(() => vi.unstubAllGlobals());
it("posts song-scoped regeneration and returns per-song operations", async () => {
  const payload = [{ operation_id: 9, song_id: "song-a", title: "A song", status: "queued", completed_jobs: 0, total_jobs: 2, error_message: null }];
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ operations: payload }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(regenerateAdminCache({ ids: ["song-a"] })).resolves.toEqual(payload);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/admin/cache/regenerate");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(init?.body as string)).toEqual({ ids: ["song-a"] });
});

it("adds the result revision to derived media URLs without changing original URLs", () => {
  const revision = "publish/next";
  expect(resultUrl(12, "stem 1", revision)).toBe("/api/jobs/12/results/stem%201?revision=publish%2Fnext");
  expect(playbackUrl(resultUrl(12, "stem 1", revision))).toBe("/api/jobs/12/results/stem%201?revision=publish%2Fnext&playback=1");
  expect(pitchVocalsUrl(12, revision)).toBe("/api/jobs/12/pitch-reference/vocals?revision=publish%2Fnext");
  expect(pitchDownloadUrl(12, revision)).toBe("/api/jobs/12/pitch?revision=publish%2Fnext");
  expect(lyricsDownloadUrl(12, revision)).toBe("/api/jobs/12/lyrics/download?revision=publish%2Fnext");
  expect(lyricsJsonDownloadUrl(12, revision)).toBe("/api/jobs/12/lyrics/download.json?revision=publish%2Fnext");
  expect(pitchedLyricsDownloadUrl(12, "lead", "odt", revision)).toBe("/api/jobs/12/pitched-lyrics/lead/download?format=odt&revision=publish%2Fnext");
  expect(originalUrl(12)).toBe("/api/jobs/12/original");
});

it("serializes the lyrics choice in the multipart job request", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ id: 8, status: "queued", position: 1, progress: { steps: ["source", "analysis", "separation", "lyrics", "export"], current: null } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await submitJob({ url: "https://example.com/song", options: { ...defaultOptions, extract_lyrics: true } });

  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/jobs");
  expect(init?.method).toBe("POST");
  expect(init?.credentials).toBe("include");
  const body = init?.body as FormData;
  expect(body.get("extract_lyrics")).toBe("true");
  expect(body.get("extract_vocals")).toBe("false");
  expect(body.get("pitch_semitones")).toBe("0");
  expect(body.get("tempo_percent")).toBe("100");
});


it("notifies only on private 401 responses and supports unsubscribe", async () => {
  const unauthorized = () => new Response(JSON.stringify({ detail: "Session expired" }), { status: 401 });
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => unauthorized());
  vi.stubGlobal("fetch", fetchMock);
  const listener = vi.fn();
  const unsubscribe = onUnauthorized(listener);
  await expect(authStart("a@example.com")).rejects.toMatchObject({ status: 401, message: "Session expired" });
  await expect(authVerify("a@example.com", "123456")).rejects.toBeInstanceOf(AuthHttpError);
  expect(listener).not.toHaveBeenCalled();
  await expect(authMe()).rejects.toMatchObject({ status: 401 });
  await expect(getStatus()).rejects.toMatchObject({ status: 401 });
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  await expect(authLogout()).rejects.toMatchObject({ status: 401 });
  expect(listener).toHaveBeenCalledTimes(2);
});

it("does not notify on other failures and falls back for non-JSON errors", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 })));
  const listener = vi.fn();
  const unsubscribe = onUnauthorized(listener);
  await expect(authMe()).rejects.toMatchObject({ status: 503, message: "Request failed with status 503" });
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("probes the session after an EventSource error", async () => {
  let source: MockEventSource;
  class MockEventSource {
    static CLOSED = 2;
    readyState = 0;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor() { source = this; }
  }
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })));
  const listener = vi.fn();
  const unsubscribe = onUnauthorized(listener);
  const onError = vi.fn();
  const close = subscribeToJob(1, vi.fn(), onError);
  source!.onerror!();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
  expect(onError).toHaveBeenCalledOnce();
  expect(source!.close).not.toHaveBeenCalled();
  close();
  expect(source!.close).toHaveBeenCalledOnce();
  unsubscribe();
});

it("reopens a permanently closed stream and stops reconnecting after cleanup", async () => {
  vi.useFakeTimers();
  try {
    const sources: MockEventSource[] = [];
    class MockEventSource {
      static CLOSED = 2;
      readyState = MockEventSource.CLOSED;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      constructor() { sources.push(this); }
    }
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 })));
    const close = subscribeToJob(1, vi.fn());
    sources[0].onerror!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sources).toHaveLength(2);
    sources[1].onerror!();
    close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sources).toHaveLength(2);
    expect(sources[1].close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
