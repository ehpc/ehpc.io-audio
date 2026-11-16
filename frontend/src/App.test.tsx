import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";

const api = vi.hoisted(() => ({
  getCurrentJob: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
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
vi.mock("./components/SubmitForm", () => ({ default: () => <button type="button">Submit form</button> }));
vi.mock("./components/QueueStatus", () => ({ default: () => null }));
vi.mock("./ProfileView", () => ({ default: () => <section>Profile contents</section> }));
vi.mock("./AdminView", () => ({ default: () => <section>Admin contents</section> }));

type DisplayJob = { id: number; status: "done"; title: string; result_revision: string | null };
const displayJob = (result_revision: string | null): DisplayJob => ({
  id: 71, status: "done", title: "Harbor song", result_revision,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getCurrentJob.mockResolvedValue(null);
  api.listJobs.mockResolvedValue([displayJob("revision-1")]);
});
afterEach(() => { vi.restoreAllMocks(); });

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
