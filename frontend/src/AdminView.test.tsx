import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import AdminView from "./AdminView";

vi.mock("./api", async (original) => ({
  ...await original<typeof api>(),
  adminUsers: vi.fn(),
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
});
