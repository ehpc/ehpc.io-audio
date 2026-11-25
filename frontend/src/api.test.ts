import { afterEach, expect, it, vi } from "vitest";
import {
  AuthHttpError, adminCacheRegenerations, authLogout, authMe, authStart, authVerify,
  getStatus, lyricsDownloadUrl, lyricsJsonDownloadUrl, onUnauthorized, originalUrl,
  pitchDownloadUrl, pitchVocalsUrl, pitchedLyricsDownloadUrl, playbackUrl,
  resultUrl, subscribeToJob,
} from "~/api";

afterEach(() => vi.unstubAllGlobals());

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
