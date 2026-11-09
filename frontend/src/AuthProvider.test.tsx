import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthProvider, { useAuth } from "./AuthProvider";

const api = vi.hoisted(() => {
  class AuthHttpError extends Error {
    constructor(public status: number) { super(`HTTP ${status}`); }
  }
  return {
    AuthHttpError,
    authMe: vi.fn(),
    authStart: vi.fn(),
    authVerify: vi.fn(),
    authActivity: vi.fn(),
    authLogout: vi.fn(),
    onUnauthorized: vi.fn(),
  };
});
vi.mock("./api", () => api);

const profile = { id: "user-1", email: "listener@example.com", is_admin: false, invite_limit: 0, invites: [] };

const deferred = <T,>() => Promise.withResolvers<T>();

function PrivateView() {
  const auth = useAuth();
  return <section>
    <p>Private workspace</p>
    <p>{auth.profile().email}</p>
    <input aria-label="Unsaved work" />
    <button onClick={() => void auth.refresh()}>Refresh identity</button>
  </section>;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.onUnauthorized.mockReturnValue(() => {});
  api.authActivity.mockResolvedValue(undefined);
  api.authLogout.mockResolvedValue(undefined);
  api.authStart.mockResolvedValue({ message: "Check your email for a code." });
  api.authVerify.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("AuthProvider", () => {
  it("gates private content until the initial session request resolves", async () => {
    const session = deferred<typeof profile>();
    api.authMe.mockReturnValueOnce(session.promise);
    render(() => <AuthProvider><PrivateView /></AuthProvider>);

    expect(screen.getByRole("status")).toHaveTextContent("Checking your session");
    expect(screen.queryByText("Private workspace")).toBeNull();
    expect(screen.queryByText("Welcome back")).toBeNull();
    session.resolve(profile);
    expect(await screen.findByText("Private workspace")).toBeInTheDocument();
    expect(screen.queryByText("Checking your session…")).toBeNull();
  });

  it.each(["login", "register"] as const)("completes OTP %s before showing private content", async (mode) => {
    api.authMe.mockRejectedValueOnce(new api.AuthHttpError(401)).mockResolvedValueOnce(profile);
    render(() => <AuthProvider><PrivateView /></AuthProvider>);

    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    if (mode === "register") fireEvent.click(screen.getByRole("button", { name: "Register" }));
    fireEvent.input(screen.getByLabelText("Email address"), { target: { value: "listener@example.com" } });
    if (mode === "register") fireEvent.input(screen.getByLabelText("Invitation code"), { target: { value: "invite-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));

    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    expect(api.authStart).toHaveBeenCalledWith("listener@example.com", mode === "register" ? "invite-123" : undefined);
    expect(screen.queryByText("Private workspace")).toBeNull();
    fireEvent.input(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    expect(await screen.findByText("Private workspace")).toBeInTheDocument();
    expect(api.authVerify).toHaveBeenCalledWith("listener@example.com", "123456", mode === "register" ? "invite-123" : undefined);
    expect(api.authMe).toHaveBeenCalledTimes(2);
  });

  it("clears private content when the API reports an unauthorized response", async () => {
    api.authMe.mockResolvedValue(profile);
    render(() => <AuthProvider><PrivateView /></AuthProvider>);
    expect(await screen.findByText("Private workspace")).toBeInTheDocument();

    const notifyUnauthorized = api.onUnauthorized.mock.calls[0][0] as () => void;
    notifyUnauthorized();
    expect(screen.queryByText("Private workspace")).toBeNull();
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
  });

  it("clears private content when identity refresh returns 401", async () => {
    api.authMe.mockResolvedValueOnce(profile).mockRejectedValueOnce(new api.AuthHttpError(401));
    render(() => <AuthProvider><PrivateView /></AuthProvider>);
    expect(await screen.findByText("Private workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh identity" }));
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    expect(screen.queryByText("Private workspace")).toBeNull();
  });

  it("keeps private UI mounted while refreshing the same identity", async () => {
    const refreshed = deferred<typeof profile>();
    api.authMe.mockResolvedValueOnce(profile).mockReturnValueOnce(refreshed.promise);
    render(() => <AuthProvider><PrivateView /></AuthProvider>);
    const input = await screen.findByLabelText("Unsaved work") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "unsaved mix" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh identity" }));
    expect(screen.getByLabelText("Unsaved work")).toBe(input);

    refreshed.resolve({ ...profile, email: "updated@example.com" });
    expect(await screen.findByText("updated@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Unsaved work")).toBe(input);
    expect(input.value).toBe("unsaved mix");
  });

  it("recreates private UI when refresh switches identities", async () => {
    api.authMe.mockResolvedValueOnce(profile).mockResolvedValueOnce({
      ...profile, id: "user-2", email: "other@example.com",
    });
    render(() => <AuthProvider><PrivateView /></AuthProvider>);
    const previousInput = await screen.findByLabelText("Unsaved work") as HTMLInputElement;
    fireEvent.input(previousInput, { target: { value: "private draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh identity" }));
    expect(await screen.findByText("other@example.com")).toBeInTheDocument();
    const nextInput = screen.getByLabelText("Unsaved work") as HTMLInputElement;
    expect(nextInput).not.toBe(previousInput);
    expect(previousInput.isConnected).toBe(false);
    expect(nextInput.value).toBe("");
  });

  it("sends activity only for trusted visible interaction, throttled and not while pending", async () => {
    const session = deferred<typeof profile>();
    const pending = deferred<void>();
    api.authMe.mockReturnValueOnce(session.promise);
    api.authActivity.mockReturnValueOnce(pending.promise);
    const clock = vi.spyOn(Date, "now").mockReturnValue(120_000);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const addListener = vi.spyOn(document, "addEventListener");
    render(() => <AuthProvider><PrivateView /></AuthProvider>);
    const activity = addListener.mock.calls.find(([type]) => type === "pointerdown")![1] as EventListener;
    const keyboardActivity = addListener.mock.calls.find(([type]) => type === "keydown")![1] as EventListener;
    const trusted = { isTrusted: true } as Event;

    activity(trusted); // No identity yet.
    session.resolve(profile);
    await screen.findByText("Private workspace");
    activity({ isTrusted: false } as Event);
    visibility.mockReturnValue("hidden");
    activity(trusted);
    expect(api.authActivity).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    activity(trusted);
    expect(api.authActivity).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(180_000);
    activity(trusted); // Still pending, even after the throttle window.
    expect(api.authActivity).toHaveBeenCalledTimes(1);
    pending.resolve();
    await waitFor(() => {
      activity(trusted);
      expect(api.authActivity).toHaveBeenCalledTimes(2);
    });
    clock.mockReturnValue(239_999);
    activity(trusted);
    expect(api.authActivity).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(240_000);
    await waitFor(() => {
      keyboardActivity(trusted);
      expect(api.authActivity).toHaveBeenCalledTimes(3);
    });
  });
});
