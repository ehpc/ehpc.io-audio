import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import type { JobDTO, SubmitResult } from "./api";
import { registerMediaSession } from "./lib/mediaSession";

const api = vi.hoisted(() => ({
  getCurrentJob: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
  retryJob: vi.fn(),
  subscribeToJob: vi.fn(),
  jobLabel: (job: { title: string }) => job.title,
}));
vi.mock("./api", () => api);
vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    profile: () => ({ id: "user-1", email: "listener@example.test", is_admin: false, invite_limit: 0, invites: [] }),
    refresh: vi.fn(),
    logout: vi.fn(),
  }),
}));
vi.mock("./components/HistoryView", () => ({
  default: (props: {
    jobs: { id: number; status: string; title: string; result_revision: string | null }[];
    onSelect: (job: { id: number; status: string; title: string; result_revision: string | null }) => void;
    onDeleted: (id: number) => void;
  }) => <section aria-label="Test library">
    {props.jobs.map(job => <div>
      <button type="button" onClick={() => props.onSelect(job)}>{job.title}</button>
      <span>Library revision: {job.result_revision ?? "legacy"}</span>
      <button type="button" aria-label={`Delete ${job.title}`} onClick={() => props.onDeleted(job.id)}>Delete</button>
    </div>)}
  </section>,
}));
vi.mock("./components/ResultsView", () => ({
  default: (props: { job: { title: string; result_revision: string | null } }) =>
    <section aria-label="Current result"><h2>{props.job.title}</h2><p>Revision: {props.job.result_revision ?? "legacy"}</p></section>,
}));
vi.mock("./components/SubmitForm", () => ({ default: (props: { onSubmitted: (job: JobDTO) => void }) => <button type="button" onClick={() => props.onSubmitted(activeJob(72, "New song"))}>Submit form</button> }));
vi.mock("./components/QueueStatus", () => ({ default: () => null }));
vi.mock("./ProfileView", () => ({ default: () => <section>Profile contents</section> }));
vi.mock("./AdminView", () => ({ default: () => <section>Admin contents</section> }));

type DisplayJob = { id: number; status: "done"; title: string; result_revision: string | null; progress: JobDTO["progress"] };
const displayJob = (result_revision: string | null): DisplayJob => ({
  id: 71, status: "done", title: "Harbor song", result_revision,
  progress: { steps: ["source", "analysis", "export"], current: null },
});
const activeJob = (id: number, title: string): JobDTO => ({
  ...displayJob(null), id, title, status: "queued", position: 2,
} as JobDTO);
let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  vi.clearAllMocks();
  api.retryJob.mockReset();
  api.getCurrentJob.mockResolvedValue(null);
  api.listJobs.mockResolvedValue([displayJob("revision-1")]);
  api.subscribeToJob.mockReturnValue(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (scrollIntoViewDescriptor) Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

it("allows one paired song session while excluding unrelated players", () => {
  render(() => <App />);
  const master = document.createElement("audio");
  const vocal = document.createElement("audio");
  const other = document.createElement("audio");
  document.body.append(master, vocal, other);
  try {
    const playing = new Map([master, vocal, other].map(audio => [audio, false]));
    for (const audio of [master, vocal, other]) {
      Object.defineProperty(audio, "paused", { configurable: true, get: () => !playing.get(audio) });
      vi.spyOn(audio, "pause").mockImplementation(() => { playing.set(audio, false); });
    }
    const unregister = registerMediaSession(master, vocal);
    playing.set(master, true);
    fireEvent.play(master);
    playing.set(vocal, true);
    fireEvent.play(vocal);
    expect(master.paused).toBe(false);
    expect(vocal.paused).toBe(false);
    playing.set(other, true);
    fireEvent.play(other);
    expect(master.paused).toBe(true);
    expect(vocal.paused).toBe(true);
    expect(other.paused).toBe(false);
    unregister();
    playing.set(master, true);
    fireEvent.play(master);
    expect(other.paused).toBe(true);
    playing.set(vocal, true);
    fireEvent.play(vocal);
    expect(master.paused).toBe(true);
  } finally {
    master.remove();
    vocal.remove();
    other.remove();
  }
});

it("refreshes the selected same-ID entry without restoring stale results", async () => {
  api.getJob.mockResolvedValueOnce(displayJob("revision-2"))
    .mockResolvedValueOnce(displayJob("revision-2b"))
    .mockResolvedValueOnce(displayJob("revision-3"));
  render(() => <App />);
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song" }));
  expect(await screen.findByText("Revision: revision-2")).toBeInTheDocument();
  expect(await screen.findByText("Library revision: revision-2")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Harbor song" }));
  expect(await screen.findByText("Revision: revision-2b")).toBeInTheDocument();
  expect(await screen.findByText("Library revision: revision-2b")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Profile" }));
  await userEvent.click(screen.getByRole("button", { name: "Workspace" }));
  expect(await screen.findByText("Revision: revision-3")).toBeInTheDocument();
  expect(await screen.findByText("Library revision: revision-3")).toBeInTheDocument();
  expect(api.getJob).toHaveBeenNthCalledWith(3, 71);
});

it("keeps cached results visible and reports a failed refresh", async () => {
  api.getCurrentJob.mockResolvedValue(displayJob("cached"));
  api.getJob.mockRejectedValueOnce(new Error("offline"));
  render(() => <App />);
  expect(await screen.findByText("Revision: cached")).toBeInTheDocument();
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  expect(screen.getByText("Revision: cached")).toBeInTheDocument();
});

it("does not restore a selected result after its pending refresh is deleted", async () => {
  let resolveRefresh!: (value: DisplayJob) => void;
  api.getJob.mockReturnValueOnce(new Promise<DisplayJob>((resolve) => { resolveRefresh = resolve; }));
  render(() => <App />);
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song" }));
  expect(screen.getByRole("region", { name: "Current result" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Delete Harbor song" }));
  expect(screen.queryByRole("region", { name: "Current result" })).not.toBeInTheDocument();
  resolveRefresh(displayJob("deleted-late"));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Current result" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Harbor song" })).not.toBeInTheDocument();
});

it("keeps the accepted job live across selection and navigation, then opens its result", async () => {
  api.getJob.mockImplementation(async (id: number) => id === 71 ? displayJob("latest") : { ...activeJob(72, "New song"), status: "done", result_revision: "new" });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  Element.prototype.scrollIntoView = vi.fn();
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "Submit form" }));
  const dock = screen.getByRole("status");
  expect(dock).toHaveTextContent("New song");
  expect(dock).toHaveTextContent("Queued");
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledTimes(1));
  const update = api.subscribeToJob.mock.calls[0][1] as (job: JobDTO) => void;
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song" }));
  expect(await screen.findByText("Revision: latest")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Profile" }));
  update({ ...activeJob(72, "New song"), status: "running" });
  expect(dock).toHaveTextContent("Processing audio");
  update({ ...activeJob(72, "New song"), status: "done", result_revision: "new" });
  expect(dock).toHaveTextContent("Complete");
  expect(screen.getByText("Revision: latest")).toBeInTheDocument();
  expect(api.subscribeToJob).toHaveBeenCalledTimes(1);
  await userEvent.click(within(dock).getByRole("button", { name: "View result" }));
  expect(screen.getByRole("region", { name: "Current result" })).toHaveTextContent("New song");
  expect(document.activeElement).toHaveClass("processing-results");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

it("ignores late stream and fallback updates after deleting a tracked job", async () => {
  const active = activeJob(72, "New song");
  api.getCurrentJob.mockResolvedValue(active);
  api.listJobs.mockResolvedValue([active]);
  const fallback = Promise.withResolvers<JobDTO>();
  api.getJob.mockReturnValue(fallback.promise);
  render(() => <App />);
  await screen.findByRole("status");
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledTimes(1));
  const update = api.subscribeToJob.mock.calls[0][1] as (job: JobDTO) => void;
  const onError = api.subscribeToJob.mock.calls[0][2] as () => void;
  onError();
  await userEvent.click(await screen.findByRole("button", { name: "Delete New song" }));
  update({ ...active, status: "done" });
  fallback.resolve({ ...active, status: "failed", error_message: "late" });
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  expect(screen.queryByText("late")).not.toBeInTheDocument();
});

it("restores only an active current job, not an old completion", async () => {
  api.getCurrentJob.mockResolvedValue(displayJob("old"));
  render(() => <App />);
  await screen.findByText("Revision: old");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(api.subscribeToJob).not.toHaveBeenCalled();
});

it("shows a failed tracked job without replacing another selected result", async () => {
  api.getJob.mockImplementation(async (id: number) => id === 71 ? displayJob("selected") : { ...activeJob(72, "New song"), status: "failed", error_message: "Fixture failure" });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  Element.prototype.scrollIntoView = vi.fn();
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "Submit form" }));
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledTimes(1));
  const update = api.subscribeToJob.mock.calls[0][1] as (job: JobDTO) => void;
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song" }));
  await screen.findByText("Revision: selected");
  update({ ...activeJob(72, "New song"), status: "failed", error_message: "Fixture failure" });
  expect(screen.getByRole("region", { name: "Current result" })).toHaveTextContent("Harbor song");
  const dock = screen.getByRole("status");
  expect(dock).toHaveTextContent("Failed");
  expect(dock.querySelector(".job-dock-spinner")).toBeNull();
  await userEvent.click(within(dock).getByRole("button", { name: "View error" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Fixture failure");
  expect(document.activeElement).toHaveClass("processing-results");
});

it("keeps a failed job retryable after a rejected attempt and tracks an accepted retry", async () => {
  const failed = { ...activeJob(72, "Failed song"), status: "failed" as const, error_message: "Source unavailable" };
  const pending = Promise.withResolvers<SubmitResult>();
  api.getCurrentJob.mockResolvedValue(failed);
  api.retryJob.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
    id: 73, status: "queued", position: 1, progress: { steps: ["source", "analysis", "export"], current: null },
  });
  render(() => <App />);
  const alert = await screen.findByRole("alert");
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(within(alert).getByRole("button", { name: "Retrying..." })).toBeDisabled();
  pending.reject(new Error("Queue unavailable"));
  await waitFor(() => expect(alert).toHaveTextContent("Queue unavailable"));
  expect(alert).toHaveTextContent("Source unavailable");
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Failed song");
  expect(screen.getByRole("status")).toHaveTextContent("Queued");
});

it("keeps a different selected result mounted while an accepted retry appears in the dock", async () => {
  const failed = { ...activeJob(72, "Failed song"), status: "failed" as const, error_message: "Source unavailable" };
  const otherFailed = { ...activeJob(74, "Another failed song"), status: "failed" as const, error_message: "Other failure" };
  const pending = Promise.withResolvers<SubmitResult>();
  api.getCurrentJob.mockResolvedValue(failed);
  api.listJobs.mockResolvedValue([displayJob("revision-1"), otherFailed]);
  api.getJob.mockImplementation(async (id: number) => id === otherFailed.id ? otherFailed : displayJob("selected"));
  api.retryJob.mockReturnValueOnce(pending.promise);
  render(() => <App />);
  await userEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Retry" }));
  await userEvent.click(await screen.findByRole("button", { name: "Another failed song" }));
  const otherAlert = await screen.findByRole("alert");
  expect(otherAlert).toHaveTextContent("Other failure");
  expect(within(otherAlert).getByRole("button", { name: "Retry" })).toBeDisabled();
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song" }));
  const selected = await screen.findByRole("region", { name: "Current result" });
  expect(selected).toHaveTextContent("Harbor song");
  pending.resolve({ id: 73, status: "queued", position: 1, progress: { steps: ["source", "analysis", "export"], current: null } });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Failed song"));
  expect(screen.getByRole("region", { name: "Current result" })).toBe(selected);
  expect(selected).toHaveTextContent("Harbor song");
});

it("refreshes the tracked result on view and ignores a late refresh after another selection", async () => {
  const pending = Promise.withResolvers<JobDTO>();
  const old = { ...activeJob(72, "New song"), status: "done" as const, result_revision: "old" };
  const fresh = { ...old, result_revision: "fresh" };
  api.getJob.mockImplementationOnce(async () => displayJob("selected"))
    .mockResolvedValueOnce(fresh)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(displayJob("selected-again"));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  Element.prototype.scrollIntoView = vi.fn();
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "Submit form" }));
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledTimes(1));
  const update = api.subscribeToJob.mock.calls[0][1] as (job: JobDTO) => void;
  await userEvent.click(await screen.findByRole("button", { name: "Harbor song" }));
  await screen.findByText("Revision: selected");
  await userEvent.click(screen.getByRole("button", { name: "Profile" }));
  update(old);
  expect(screen.getByText("Revision: selected")).toBeInTheDocument();
  await userEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "View result" }));
  expect(await screen.findByText("Revision: fresh")).toBeInTheDocument();
  expect(api.getJob).toHaveBeenNthCalledWith(2, 72);
  await userEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "View result" }));
  await userEvent.click(screen.getByRole("button", { name: "Harbor song" }));
  expect(await screen.findByText("Revision: selected-again")).toBeInTheDocument();
  pending.resolve({ ...old, result_revision: "late" });
  await waitFor(() => expect(screen.queryByText("Revision: late")).not.toBeInTheDocument());
  expect(screen.getByRole("region", { name: "Current result" })).toHaveTextContent("Harbor song");
});

it("does not let a late disconnect snapshot overwrite a newer live update", async () => {
  const active = activeJob(72, "New song");
  const pending = Promise.withResolvers<JobDTO>();
  api.getCurrentJob.mockResolvedValue(active);
  api.getJob.mockReturnValue(pending.promise);
  render(() => <App />);
  const dock = await screen.findByRole("status");
  await waitFor(() => expect(api.subscribeToJob).toHaveBeenCalledTimes(1));
  const update = api.subscribeToJob.mock.calls[0][1] as (job: JobDTO) => void;
  const onError = api.subscribeToJob.mock.calls[0][2] as () => void;
  onError();
  update({ ...active, status: "running" });
  expect(dock).toHaveTextContent("Processing audio");
  pending.resolve(active);
  await pending.promise;
  expect(dock).toHaveTextContent("Processing audio");
});
