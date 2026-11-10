import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { createInvite, deleteInvite, type AuthProfile } from "./api";
import { Button } from "~/components/button";
import { Card, CardContent } from "~/components/card";

const formatTimestamp = (timestamp: number) => new Date(timestamp * 1000).toLocaleString();

const ProfileView: Component<{ profile: AuthProfile; refresh: () => Promise<void> }> = (props) => {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const occupied = createMemo(() => props.profile.invites.filter(
    (invite) => invite.status === "pending" || invite.status === "activated",
  ).length);

  const create = async () => {
    if (busy()) return;
    setBusy("create");
    setError("");
    setNotice("");
    try {
      await createInvite();
      await props.refresh();
      setNotice("Invite created.");
    } catch (err) {
      setError(`Could not create invite or refresh profile: ${err instanceof Error ? err.message : "Please try again."}`);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string) => {
    if (busy() || !window.confirm("Withdraw this unused invitation? This does not disable an account.")) return;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await deleteInvite(id);
      await props.refresh();
      setNotice("Invitation withdrawn.");
    } catch (err) {
      setError(`Could not withdraw invitation or refresh profile: ${err instanceof Error ? err.message : "Please try again."}`);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (code: string) => {
    setError("");
    setNotice("");
    try {
      await navigator.clipboard.writeText(code);
      setNotice("Code copied.");
    } catch {
      setError("Could not copy code.");
    }
  };

  return (
    <section class="space-y-4" aria-labelledby="profile-heading">
      <div>
        <h2 id="profile-heading" class="text-lg font-semibold">Profile</h2>
        <p class="break-all text-sm text-muted-foreground">{props.profile.email}</p>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="font-medium">Invitations</h3>
          <Show when={props.profile.invite_limit === null} fallback={<p class="text-sm text-muted-foreground">{occupied()} of {props.profile.invite_limit} invite slots used · {Math.max(0, (props.profile.invite_limit ?? 0) - occupied())} remaining</p>}>
            <p class="text-sm text-muted-foreground">Unlimited invitations · {occupied()} used</p>
          </Show>
        </div>
        <Button type="button" disabled={busy() !== null || (props.profile.invite_limit !== null && occupied() >= props.profile.invite_limit)} onClick={create}>
          {busy() === "create" ? "Creating..." : "Create invite"}
        </Button>
      </div>
      <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
      <p role="status" class="text-sm text-muted-foreground">{notice()}</p>
      <Show when={props.profile.invites.length > 0} fallback={<p class="text-sm text-muted-foreground">No invites yet.</p>}>
        <ul class="space-y-2">
          <For each={props.profile.invites}>{(invite) => (
            <li>
              <Card>
                <CardContent class="space-y-2 p-4">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="text-sm font-medium capitalize">{invite.status}</span>
                    <span class="text-xs text-muted-foreground">Created {formatTimestamp(invite.created_at)}</span>
                  </div>
                  <Show when={invite.code}>{(code) => (
                    <div class="flex flex-wrap items-center gap-2">
                      <code class="min-w-0 select-all break-all text-sm">{code()}</code>
                      <Button type="button" size="sm" variant="outline" onClick={() => copy(code())}>Copy code</Button>
                    </div>
                  )}</Show>
                  <Show when={invite.recipient_email}><p class="break-all text-sm">Recipient: {invite.recipient_email}</p></Show>
                  <Show when={invite.activated_at}>{(activatedAt) => (
                    <p class="text-sm text-muted-foreground">Activated: {formatTimestamp(activatedAt())}</p>
                  )}</Show>
                  <Show when={props.profile.is_admin && invite.status === "pending"}>
                    <Button type="button" size="sm" variant="destructive" class="min-h-11" disabled={busy() !== null} onClick={() => revoke(invite.id)}>
                      {busy() === invite.id ? "Withdrawing..." : "Withdraw unused invitation"}
                    </Button>
                  </Show>
                </CardContent>
              </Card>
            </li>
          )}</For>
        </ul>
      </Show>
    </section>
  );
};

export default ProfileView;
