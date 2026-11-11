import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "./api";
import AdminCacheView from "./AdminCacheView";

vi.mock("./api", async original => ({ ...await original<typeof api>(), adminCache: vi.fn(), clearAdminCache: vi.fn() }));
const songs = [
  { id: "a", title: "Silver harbor", artist: "Example singer", bytes: 4096 },
  { id: "b", title: "Quiet morning", artist: null, bytes: 2048 },
];
const ready: api.AdminCache = { songs, unattributed_bytes: 0, selective_ready: true, busy: false, unsafe: false };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.mocked(api.adminCache).mockResolvedValue(ready);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps both cached songs after cancel and displays the confirmed single clear", async () => {
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

it("preserves the list and selection after a busy conflict, then clears the selected songs", async () => {
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

it("blocks selective clearing when legacy data is unattributed but permits confirmed full clearing", async () => {
  vi.mocked(api.adminCache).mockResolvedValueOnce({ ...ready, selective_ready: false, unattributed_bytes: 8192 })
    .mockResolvedValueOnce({ ...ready, songs: [] });
  vi.mocked(api.clearAdminCache).mockResolvedValue({ cleared: 2, reclaimed_bytes: 8192 });
  render(() => <AdminCacheView />);
  expect(await screen.findByText(/older cache data cannot be attributed/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear Silver harbor" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Clear all cache" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/Shared cached work/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm clear" }));
  expect(await screen.findByText("No cached songs.")).toBeInTheDocument();
});

it("blocks clearing while the server reports active or unsafe work", async () => {
  vi.mocked(api.adminCache).mockResolvedValueOnce({ ...ready, busy: true })
    .mockResolvedValueOnce({ ...ready, unsafe: true, selective_ready: false })
    .mockResolvedValueOnce(ready);
  render(() => <AdminCacheView />);
  expect(await screen.findByText(/Active, queued or unresolved work/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear all cache" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Refresh cache" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("cannot be safely cleared");
  expect(screen.queryByText(/older cache data cannot be attributed/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear Silver harbor" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Refresh cache" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Clear all cache" })).toBeEnabled());
});
