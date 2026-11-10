import { afterEach, expect, it, vi } from "vitest";
import {
  AuthHttpError, authLogout, authMe, authStart, authVerify, getStatus, onUnauthorized,
  submitJob, subscribeToJob, type SeparationOptions,
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

it("serializes the lyrics choice in the multipart job request", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ id: 8, status: "queued", position: 1 }), {
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
  subscribeToJob(1, vi.fn(), onError);
  source!.onerror!();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
  expect(onError).toHaveBeenCalledOnce();
  expect(source!.close).toHaveBeenCalledOnce();
  unsubscribe();
});
