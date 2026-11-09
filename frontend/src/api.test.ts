import { afterEach, expect, it, vi } from "vitest";
import {
  adminUsers, AuthHttpError, authActivity, authLogout, authMe, authStart, authVerify,
  createInvite, deleteInvite, getStatus, onUnauthorized, revokeUserSessions, submitJob,
  subscribeToJob, updateAdminUser, type SeparationOptions,
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

it("sends authentication requests with the backend contract", async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: "sent" }), { status: 202 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ email: "a@example.com" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "u", email: "a@example.com", is_admin: false, invite_limit: 3, invites: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "i", code: "secret" })))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);

  expect(await authStart("a@example.com", "invite")).toEqual({ message: "sent" });
  expect(await authVerify("a@example.com", "123456", "invite")).toEqual({ email: "a@example.com" });
  expect((await authMe()).id).toBe("u");
  expect(await createInvite()).toEqual({ id: "i", code: "secret" });
  await deleteInvite("i/1");
  await authActivity();
  await authLogout();

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/api/auth/start", "/api/auth/verify", "/api/auth/me", "/api/auth/invites",
    "/api/auth/invites/i%2F1", "/api/auth/activity", "/api/auth/logout",
  ]);
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ email: "a@example.com", invite_code: "invite" });
  expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({ email: "a@example.com", code: "123456", invite_code: "invite" });
  expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
  expect(fetchMock.mock.calls[4][1]?.method).toBe("DELETE");
});

it("sends administrator requests and handles empty responses", async () => {
  const user = { id: "u", email: "a@example.com", is_admin: false, invite_limit: 2, disabled: false };
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify([user])))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...user, disabled: true })))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await adminUsers()).toEqual([user]);
  expect((await updateAdminUser("u/1", { disabled: true, invite_limit: 2 })).disabled).toBe(true);
  await revokeUserSessions("u/1");
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/api/admin/users", "/api/admin/users/u%2F1", "/api/admin/users/u%2F1/revoke-sessions",
  ]);
  expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
  expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({ disabled: true, invite_limit: 2 });
  expect(fetchMock.mock.calls[2][1]?.method).toBe("POST");
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
