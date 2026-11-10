import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import ProfileView from "./ProfileView";

vi.mock("./api", async (original) => ({
  ...await original<typeof api>(),
  createInvite: vi.fn(),
  deleteInvite: vi.fn(),
}));

const profile: api.AuthProfile = {
  id: "user-1", email: "owner@example.com", is_admin: false, invite_limit: 3,
  invites: [
    { id: "invite-1", code: "PENDING-CODE", status: "pending", recipient_email: null, activated_at: null, created_at: 1700000000 },
    { id: "invite-2", code: null, status: "activated", recipient_email: "friend@example.com", activated_at: 1700000100, created_at: 1700000000 },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.createInvite).mockResolvedValue(profile.invites[0]);
  vi.mocked(api.deleteInvite).mockResolvedValue(undefined);
});

describe("ProfileView", () => {
  it("shows occupied slots and recipient details without access or withdrawal controls for members", () => {
    render(() => <ProfileView profile={profile} refresh={vi.fn()} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 invite slots used.*1 remaining/)).toBeInTheDocument();
    expect(screen.getByText("Recipient: friend@example.com")).toBeInTheDocument();
    expect(screen.getByText(/^Activated:/)).toBeInTheDocument();
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]).getByText("pending")).toBeInTheDocument();
    expect(within(cards[0]).queryByRole("button", { name: /withdraw|revoke/i })).not.toBeInTheDocument();
    expect(within(cards[1]).getByText("activated")).toBeInTheDocument();
    expect(within(cards[1]).queryByRole("button", { name: /withdraw|revoke|disable/i })).not.toBeInTheDocument();
  });

  it("creates an invite and refreshes the profile, but disables creation at the limit", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = render(() => <ProfileView profile={profile} refresh={refresh} />);
    await userEvent.click(screen.getByRole("button", { name: "Create invite" }));
    expect(api.createInvite).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(await screen.findByText("Invite created.")).toBeInTheDocument();
    view.unmount();
    render(() => <ProfileView profile={{ ...profile, invite_limit: 2 }} refresh={refresh} />);
    expect(screen.getByRole("button", { name: "Create invite" })).toBeDisabled();
  });

  it("keeps unlimited admin invitations available beyond the regular allowance", async () => {
    const invites = Array.from({ length: 4 }, (_, index) => ({ ...profile.invites[0], id: `pending-${index}` }));
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(() => <ProfileView profile={{ ...profile, is_admin: true, invite_limit: null, invites }} refresh={refresh} />);
    expect(screen.getByText(/Unlimited invitations.*4 used/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create invite" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("lets an unlimited admin withdraw only unused invitations after confirmation", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(() => <ProfileView profile={{ ...profile, is_admin: true, invite_limit: null }} refresh={refresh} />);
    expect(screen.getByText(/Unlimited invitations/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create invite" })).toBeEnabled();
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[1]).queryByRole("button", { name: /withdraw|revoke|disable/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw unused invitation" }));
    expect(api.deleteInvite).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw unused invitation" }));
    expect(api.deleteInvite).toHaveBeenCalledWith("invite-1");
    expect(refresh).toHaveBeenCalledOnce();
    expect(await screen.findByText("Invitation withdrawn.")).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("reports API and refresh failures instead of claiming success", async () => {
    vi.mocked(api.createInvite).mockRejectedValueOnce(new Error("quota exceeded"));
    const refresh = vi.fn().mockRejectedValueOnce(new Error("refresh failed"));
    render(() => <ProfileView profile={profile} refresh={refresh} />);
    await userEvent.click(screen.getByRole("button", { name: "Create invite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("quota exceeded");
    expect(refresh).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Create invite" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("refresh failed"));
    expect(screen.queryByText("Invite created.")).not.toBeInTheDocument();
  });

  it("copies the invite code and reports clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    render(() => <ProfileView profile={profile} refresh={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("PENDING-CODE");
    expect(await screen.findByText("Code copied.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy code.");
  });
});
