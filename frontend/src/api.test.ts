import { afterEach, expect, it, vi } from "vitest";
import { submitJob, type SeparationOptions } from "~/api";

const defaultOptions: SeparationOptions = {
  extract_vocals: false,
  extract_instruments: false,
  extract_lyrics: false,
  detect_pitch: false,
  mix_female_instruments: false,
  mix_male_instruments: false,
  mix_backing_instruments: false,
  mix_lead_instruments: false,
  decrowd: false,
  decrowd_vocals: false,
  dereverb: false,
  genders: false,
  lead_backing: false,
  drums: false,
  no_cache: false,
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
