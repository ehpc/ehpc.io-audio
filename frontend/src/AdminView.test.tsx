import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import AdminView from "./AdminView";

vi.mock("./api", async (original) => ({
  ...await original<typeof api>(),
  adminUsers: vi.fn(),
  adminUserActivity: vi.fn(),
  grantInviteSlot: vi.fn(),
  deleteInvite: vi.fn(),
  updateAdminUser: vi.fn(),
  revokeUserSessions: vi.fn(),
}));

const user: api.AdminUser = {
  id: "user-1", email: "person@example.com", is_admin: false, invite_limit: 2, disabled: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.adminUsers).mockResolvedValue([user]);
  vi.mocked(api.updateAdminUser).mockResolvedValue(user);
  vi.mocked(api.grantInviteSlot).mockResolvedValue({ ...user, invite_limit: 3 });
  vi.mocked(api.deleteInvite).mockResolvedValue(undefined);
  vi.mocked(api.adminUserActivity).mockResolvedValue({
    registered_at: null, last_login_at: null, last_activity_at: null, invite_used: 0, invites: [], jobs: [], searches: [],
  });
  vi.mocked(api.revokeUserSessions).mockResolvedValue(undefined);
});

describe("AdminView", () => {
  it("loads people and saves an edited invite limit for the selected user", async () => {
    render(() => <AdminView />);
    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
    const input = screen.getByLabelText("Invite limit");
    expect(input).toHaveValue(2);
    fireEvent.input(input, { target: { value: "5" } });
    await userEvent.click(screen.getByRole("button", { name: "Save limit" }));
    expect(api.updateAdminUser).toHaveBeenCalledWith("user-1", { invite_limit: 5 });
    expect(await screen.findByText("Invite limit saved.")).toBeInTheDocument();
  });

  it("requires confirmation before disabling or enabling an account", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(() => <AdminView />);
    await screen.findByText("person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(api.updateAdminUser).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(api.updateAdminUser).toHaveBeenCalledWith("user-1", { disabled: true });
    expect(await screen.findByText("Account disabled.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(api.updateAdminUser).toHaveBeenLastCalledWith("user-1", { disabled: false });
    expect(await screen.findByText("Account enabled.")).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("confirms session revocation and reports failures", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    vi.mocked(api.revokeUserSessions).mockRejectedValueOnce(new Error("revocation denied"));
    render(() => <AdminView />);
    await screen.findByText("person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));
    expect(api.revokeUserSessions).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));
    expect(api.revokeUserSessions).toHaveBeenCalledWith("user-1");
    expect(await screen.findByRole("alert")).toHaveTextContent("revocation denied");
    expect(screen.queryByText("Sessions revoked.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revoke sessions" }));
    expect(await screen.findByText("Sessions revoked.")).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("reports load errors and allows refresh to recover", async () => {
    vi.mocked(api.adminUsers).mockRejectedValueOnce(new Error("not authorized"));
    render(() => <AdminView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not authorized");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(api.adminUsers).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing account state when an update fails", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.updateAdminUser).mockRejectedValueOnce(new Error("update denied"));
    render(() => <AdminView />);
    await screen.findByText("person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("update denied");
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
    expect(screen.queryByText("Account disabled.")).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it("grants a slot using the server result, with busy and error states", async () => {
    const { promise, resolve: resolveGrant } = Promise.withResolvers<api.AdminUser>();
    vi.mocked(api.grantInviteSlot).mockReturnValueOnce(promise)
      .mockRejectedValueOnce(new Error("grant denied"));
    render(() => <AdminView />);
    await screen.findByText("person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Grant +1 invite" }));
    expect(api.grantInviteSlot).toHaveBeenCalledWith("user-1");
    expect(screen.getByRole("button", { name: "Grant +1 invite" })).toBeDisabled();
    resolveGrant({ ...user, invite_limit: 7 });
    expect(await screen.findByText("One invite slot granted.")).toBeInTheDocument();
    expect(screen.getByLabelText("Invite limit")).toHaveValue(7);
    await userEvent.click(screen.getByRole("button", { name: "Grant +1 invite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("grant denied");
    expect(screen.getByLabelText("Invite limit")).toHaveValue(7);
  });

  it("shows an unlimited administrator without quota controls", async () => {
    vi.mocked(api.adminUsers).mockResolvedValue([{ ...user, is_admin: true, invite_limit: null }]);
    render(() => <AdminView />);
    expect(await screen.findByText("Invite limit: Unlimited")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant +1 invite" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Invite limit")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("loads real activity and only allows pending invitations to be revoked", async () => {
    const activity: api.AdminUserActivity = {
      registered_at: null, last_login_at: null, last_activity_at: 123, invite_used: 52,
      invites: [
        { id: "pending", status: "pending", recipient_email: "pending@example.com", created_at: 100, activated_at: null },
        { id: "used", status: "activated", recipient_email: "used@example.com", created_at: 101, activated_at: 102 },
      ],
      jobs: [{ id: 42, title: "Song title", status: "done", created_at: 100, started_at: null, finished_at: 102 }],
      searches: [{ id: "search-1", query: "search terms", status: "completed", created_at: 101 }],
    };
    vi.mocked(api.adminUserActivity).mockResolvedValueOnce(activity).mockResolvedValueOnce({ ...activity, invite_used: 51, invites: [] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(() => <AdminView />);
    await screen.findByText("person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "View activity" }));
    expect(await screen.findByText("Last login: Unknown")).toBeInTheDocument();
    expect(screen.getByText("Invite slots used: 52 (pending and activated)")).toBeInTheDocument();
    expect(screen.getByText("Registered: Unknown")).toBeInTheDocument();
    expect(screen.getByText(/Job #42/)).toHaveTextContent("Song title");
    expect(screen.getByText(/Search search-1/)).toHaveTextContent("search terms");
    expect(screen.getByText(/Job #42/)).toHaveTextContent("Started: Unknown");
    expect(screen.getByText(/Search search-1/)).toHaveTextContent("completed");
    expect(screen.getAllByRole("button", { name: "Withdraw unused invitation" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Withdraw unused invitation" }));
    expect(api.deleteInvite).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw unused invitation" }));
    expect(api.deleteInvite).toHaveBeenCalledWith("pending");
    expect(await screen.findByText("No invites.")).toBeInTheDocument();
    expect(api.adminUserActivity).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("reports revocation errors without removing the invitation", async () => {
    vi.mocked(api.adminUserActivity).mockResolvedValue({
      registered_at: null, last_login_at: null, last_activity_at: null, invite_used: 1,
      invites: [{ id: "pending", status: "pending", recipient_email: null, created_at: 100, activated_at: null }],
      jobs: [], searches: [],
    });
    vi.mocked(api.deleteInvite).mockRejectedValueOnce(new Error("revoke denied"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(() => <AdminView />);
    await screen.findByText("person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "View activity" }));
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw unused invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("revoke denied");
    expect(screen.getByRole("button", { name: "Withdraw unused invitation" })).toBeEnabled();
    expect(api.adminUserActivity).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it("allows retrying a failed activity load", async () => {
    vi.mocked(api.adminUserActivity).mockRejectedValueOnce(new Error("activity denied"));
    render(() => <AdminView />);
    await screen.findByText("person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "View activity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("activity denied");
    await userEvent.click(screen.getByRole("button", { name: "Retry activity" }));
    expect(await screen.findByText("No jobs.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
