import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "./api";
import AdminCacheView from "./AdminCacheView";

vi.mock("./api", async original => ({
  ...await original<typeof api>(),
  adminCache: vi.fn(),
  adminCacheRegenerations: vi.fn(),
  clearAdminCache: vi.fn(),
  regenerateAdminCache: vi.fn(),
}));
const songs: api.AdminCacheSong[] = [
  { id: "a", title: "Silver harbor", artist: "Example singer", bytes: 4096, regenerable: true, matched_jobs: 2, unavailable_reason: null },
  { id: "b", title: "Quiet morning", artist: null, bytes: 2048, regenerable: false, matched_jobs: 0, unavailable_reason: "No verified saved original is available." },
];
const ready: api.AdminCache = { songs, unattributed_bytes: 0, selective_ready: true, busy: false, unsafe: false, unmatched_completed_jobs: 0 };
const operation = (status: api.SongRegeneration["status"] = "queued"): api.SongRegeneration => ({
  operation_id: 501,
  song_id: "a",
  title: "Silver harbor",
  status,
  completed_jobs: status === "done" ? 2 : 0,
  total_jobs: 2,
  error_message: status === "failed" ? "Synthetic rebuild failure" : null,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.mocked(api.adminCache).mockResolvedValue(ready);
  vi.mocked(api.adminCacheRegenerations).mockResolvedValue([]);
  vi.mocked(api.regenerateAdminCache).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};

it("keeps an accepted song operation when its older status read arrives late", async () => {
  const oldStatus = deferred<api.SongRegeneration[]>();
  vi.mocked(api.adminCacheRegenerations).mockReturnValueOnce(oldStatus.promise);
  vi.mocked(api.regenerateAdminCache).mockResolvedValueOnce([operation()]);
  render(() => <AdminCacheView />);
  await screen.findByText("Silver harbor");
  await userEvent.click(screen.getByRole("button", { name: "Regenerate Silver harbor" }));
  await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear cache and regenerate" }));
  const status = await screen.findByRole("region", { name: "Regeneration status" });
  expect(within(status).getByText("Queued")).toBeInTheDocument();
  oldStatus.resolve([]);
  await waitFor(() => expect(within(status).getByText("Queued")).toBeInTheDocument());
});

it("does not let a rejected submission invalidate an in-flight status read", async () => {
  const pendingStatus = deferred<api.SongRegeneration[]>();
  const unrelated = { ...operation("running"), operation_id: 502, song_id: "other", title: "Other song" };
  vi.mocked(api.adminCacheRegenerations).mockReturnValueOnce(pendingStatus.promise);
  vi.mocked(api.regenerateAdminCache).mockRejectedValueOnce(new api.AuthHttpError(409, "Regeneration is already active."));
  render(() => <AdminCacheView />);
  await screen.findByText("Silver harbor");
  await userEvent.click(screen.getByRole("button", { name: "Regenerate Silver harbor" }));
  const dialog = screen.getByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Clear cache and regenerate" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Regeneration is already active");
  pendingStatus.resolve([unrelated]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  const status = await screen.findByRole("region", { name: "Regeneration status" });
  expect(await within(status).findByText("Regenerating")).toBeInTheDocument();
});
it("keeps both cached songs after clear cancellation and removes only the confirmed song", async () => {
  vi.mocked(api.adminCache).mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, songs: [songs[1]] });
  vi.mocked(api.clearAdminCache).mockResolvedValue({ cleared: 2, reclaimed_bytes: 4096 });
  render(() => <AdminCacheView />);
  await screen.findByText("Silver harbor");
  await userEvent.click(screen.getByRole("button", { name: "Clear Silver harbor" }));
  let dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/GPU costs/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  expect(screen.getByText("Silver harbor")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear Silver harbor" }));
  dialog = screen.getByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm clear" }));
  expect(await screen.findByText(/Cleared 2 cache files/)).toBeInTheDocument();
  expect(screen.queryByText("Silver harbor")).not.toBeInTheDocument();
  expect(screen.getByText("Quiet morning")).toBeInTheDocument();
});

it("preserves selected songs after a clear conflict so the selection can be retried", async () => {
  vi.mocked(api.clearAdminCache).mockRejectedValueOnce(new api.AuthHttpError(409, "Processing is active; try again later."))
    .mockResolvedValueOnce({ cleared: 2, reclaimed_bytes: 6144 });
  vi.mocked(api.adminCache).mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, songs: [] });
  render(() => <AdminCacheView />);
  await screen.findByText("Silver harbor");
  await userEvent.click(screen.getByRole("checkbox", { name: /Silver harbor/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /Quiet morning/ }));
  await userEvent.click(screen.getByRole("button", { name: "Clear selected (2)" }));
  let dialog = screen.getByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm clear" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Processing is active");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  expect(screen.getByRole("checkbox", { name: /Silver harbor/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Quiet morning/ })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Clear selected (2)" }));
  dialog = screen.getByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm clear" }));
  expect(await screen.findByText("No cached songs.")).toBeInTheDocument();
});

it("blocks selective cache clearing when attribution is incomplete but permits full clearing", async () => {
  vi.mocked(api.adminCache).mockResolvedValueOnce({ ...ready, selective_ready: false, unattributed_bytes: 8192 })
    .mockResolvedValueOnce({ ...ready, songs: [] });
  vi.mocked(api.clearAdminCache).mockResolvedValue({ cleared: 2, reclaimed_bytes: 8192 });
  render(() => <AdminCacheView />);
  expect(await screen.findByText(/older cache data cannot be attributed/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear selected (0)" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Clear Silver harbor" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Clear all cache" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/Shared cached work/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm clear" }));
  expect(await screen.findByText("No cached songs.")).toBeInTheDocument();
});

it("blocks all cache clearing and regeneration while the server reports active or unsafe work", async () => {
  vi.mocked(api.adminCache).mockResolvedValueOnce({ ...ready, busy: true })
    .mockResolvedValueOnce({ ...ready, unsafe: true, selective_ready: false })
    .mockResolvedValueOnce(ready);
  render(() => <AdminCacheView />);
  expect(await screen.findByText(/Active, queued or unresolved work/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear all cache" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /Silver harbor/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Regenerate Silver harbor" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Refresh cache" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("cannot be safely cleared");
  expect(screen.queryByText(/older cache data cannot be attributed/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear Silver harbor" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Regenerate Silver harbor" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Refresh cache" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Clear all cache" })).toBeEnabled());
});


it("keeps the selected song after cancel and explains in-place replacement before regeneration", async () => {
  render(() => <AdminCacheView />);
  await screen.findByText("Silver harbor");
  await userEvent.click(screen.getByRole("button", { name: "Regenerate Silver harbor" }));
  let dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/clears reusable cache for the selected songs/)).toBeInTheDocument();
  expect(within(dialog).getByText(/same Library entry is updated without duplicates/)).toBeInTheDocument();
  expect(within(dialog).getByText(/GPU costs/)).toBeInTheDocument();
  expect(within(dialog).queryByText(/Completed job #/)).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  expect(screen.getByText("Silver harbor")).toBeInTheDocument();
  expect(api.regenerateAdminCache).not.toHaveBeenCalled();
});

it("starts song-scoped regeneration and keeps the same cache/library row while showing saved-variant progress", async () => {
  vi.mocked(api.adminCache).mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, busy: true });
  vi.mocked(api.regenerateAdminCache).mockResolvedValueOnce([operation()]);
  render(() => <AdminCacheView />);
  await screen.findByText("Silver harbor");
  await userEvent.click(screen.getByRole("button", { name: "Regenerate Silver harbor" }));
  const dialog = screen.getByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Clear cache and regenerate" }));
  await waitFor(() => expect(api.regenerateAdminCache).toHaveBeenCalledWith({ ids: ["a"] }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Cached songs" })).getByRole("button", { name: "Regenerate Silver harbor" })).toBeInTheDocument();
  const status = screen.getByRole("region", { name: "Regeneration status" });
  expect(within(status).getByText("Queued")).toBeInTheDocument();
  expect(within(status).getByText("0 of 2 saved job variants completed.")).toBeInTheDocument();
});

it("keeps the confirmation and selection retryable after a preflight conflict", async () => {
  vi.mocked(api.regenerateAdminCache)
    .mockRejectedValueOnce(new api.AuthHttpError(409, "Processing must finish before regeneration."))
    .mockResolvedValueOnce([operation()]);
  render(() => <AdminCacheView />);
  await screen.findByText("Silver harbor");
  await userEvent.click(screen.getByRole("button", { name: "Regenerate Silver harbor" }));
  let dialog = screen.getByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", { name: "Clear cache and regenerate" });
  await userEvent.click(confirm);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Processing must finish");
  expect(within(dialog).getByText("2 saved job variants across all owners and settings.")).toBeInTheDocument();
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  await waitFor(() => expect(api.regenerateAdminCache).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Cached songs" })).getByRole("button", { name: "Regenerate Silver harbor" })).toBeInTheDocument();
});

it("refreshes cache once an operation reaches a terminal status", async () => {
  const updated = { ...ready, songs: [{ ...songs[0], bytes: 2048 }, songs[1]] };
  vi.mocked(api.adminCache).mockResolvedValueOnce(ready).mockResolvedValueOnce(updated);
  vi.mocked(api.adminCacheRegenerations).mockResolvedValueOnce([operation()]);
  render(() => <AdminCacheView />);
  const status = await screen.findByRole("region", { name: "Regeneration status" });
  expect(await within(status).findByText("Queued")).toBeInTheDocument();
  vi.mocked(api.adminCacheRegenerations).mockResolvedValueOnce([operation("done")]);
  await userEvent.click(within(status).getByRole("button", { name: "Refresh regeneration status" }));
  expect(await within(status).findByText(/Completed/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate Silver harbor" }).closest("li")).toHaveTextContent("2.0 KiB"));
  expect(api.adminCache).toHaveBeenCalledTimes(2);
});

it("reports unmatched and unavailable originals while blocking regeneration when attribution is incomplete", async () => {
  vi.mocked(api.adminCache).mockResolvedValueOnce({ ...ready, unmatched_completed_jobs: 3, selective_ready: false, unattributed_bytes: 8192 });
  render(() => <AdminCacheView />);
  expect(await screen.findByText(/older cache data cannot be attributed/)).toBeInTheDocument();
  expect(screen.getByText(/3 completed jobs have no safely matched original/)).toBeInTheDocument();
  expect(screen.getByText("No verified saved original is available.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Regenerate Silver harbor" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Regenerate Quiet morning" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Regenerate selected (0)" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /Silver harbor/ })).toBeDisabled();
});
