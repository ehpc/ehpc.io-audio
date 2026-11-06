import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { searchSong } from "./api";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

it("normalizes Unicode input and polls the opaque session-bound handle until a catalog match arrives", async () => {
  const songs = [{ title: "First Love", artists: ["宇多田ヒカル"], url: "https://music.youtube.com/watch?v=o1sUaVJUeB0", duration_seconds: 258, thumbnail_url: null, play_count: null, play_count_approximate: false }];
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ search_id: "opaque/id", status: "pending" }, 202))
    .mockResolvedValueOnce(response({ status: "pending" }))
    .mockResolvedValueOnce(response({ status: "done", songs }));
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  const pending = searchSong("  宇多田ヒカル \n First   Love ", controller.signal);
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]).toEqual(["/api/song-search", expect.objectContaining({ method: "POST", credentials: "include", signal: controller.signal,
    body: JSON.stringify({ query: "宇多田ヒカル First Love" }),
  })]);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchMock.mock.calls[1]).toEqual(["/api/song-search/opaque%2Fid", expect.objectContaining({ credentials: "include", signal: controller.signal })]);
  await vi.advanceTimersByTimeAsync(2000);
  await expect(pending).resolves.toEqual(songs);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([404, 422, 502, 503])("surfaces terminal %s details and does not poll again", async status => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ search_id: "handle", status: "pending" }, 202))
    .mockResolvedValueOnce(response({ detail: "Please specify an artist." }, status));
  vi.stubGlobal("fetch", fetchMock);
  const pending = searchSong("a song", new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow("Please specify an artist.");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  await vi.advanceTimersByTimeAsync(8000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("stops the pending delay on cancellation without sending another request", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ search_id: "handle", status: "pending" }, 202));
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  const pending = searchSong("a song", controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports a rejected initial request without polling", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ detail: "Enter a song description." }, 422));
  vi.stubGlobal("fetch", fetchMock);
  await expect(searchSong(" ", new AbortController().signal)).rejects.toThrow("Enter a song description.");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
