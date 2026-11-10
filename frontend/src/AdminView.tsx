import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { adminUserActivity, adminUsers, deleteInvite, grantInviteSlot, revokeUserSessions, updateAdminUser, type AdminUser, type AdminUserActivity } from "./api";
import { Button } from "~/components/button";
import { Card, CardContent } from "~/components/card";

const timestamp = (value: number | null) => value === null ? "Unknown" : new Date(value * 1000).toLocaleString();

const Activity: Component<{ userId: string }> = (props) => {
  const [activity, setActivity] = createSignal<AdminUserActivity | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [revoking, setRevoking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setActivity(await adminUserActivity(props.userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity.");
    } finally {
      setLoading(false);
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this pending invitation?")) return;
    setRevoking(true);
    setError(null);
    try {
      await deleteInvite(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke invitation.");
    } finally {
      setRevoking(false);
    }
  };
  onMount(load);

  return (
    <section class="space-y-3 border-t pt-4" aria-label="Activity">
      <Show when={loading()}><p role="status">Loading activity...</p></Show>
      <Show when={revoking() && !loading()}><p role="status">Revoking invitation...</p></Show>
      <Show when={error()}>
        <p class="text-sm text-destructive" role="alert">{error()}</p>
        <Button type="button" variant="outline" size="sm" disabled={loading()} onClick={load}>Retry activity</Button>
      </Show>
      <Show when={activity()} keyed>
        {(data) => (
          <div class="space-y-3 text-sm">
            <p>Registered: {timestamp(data.registered_at)}</p>
            <p class="text-muted-foreground">Showing up to the 50 most recent entries in each category.</p>
            <p>Last login: {timestamp(data.last_login_at)}</p>
            <p>Last activity: {timestamp(data.last_activity_at)}</p>
            <div>
              <h3 class="font-medium">Invites</h3>
              <p>Invite slots used: {data.invite_used} (pending and activated)</p>
              <Show when={data.invites.length} fallback={<p>No invites.</p>}>
                <ul class="space-y-2">
                  <For each={data.invites}>{(invite) => (
                    <li class="break-words">
                      {invite.recipient_email ?? "No recipient"} · {invite.status} · Created: {timestamp(invite.created_at)} · Activated: {timestamp(invite.activated_at)}
                      <Show when={invite.status === "pending"}>
                        <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={revoking() || loading()} onClick={() => void revoke(invite.id)}>Withdraw unused invitation</Button>
                      </Show>
                    </li>
                  )}</For>
                </ul>
              </Show>
            </div>
            <div>
              <h3 class="font-medium">Jobs</h3>
              <Show when={data.jobs.length} fallback={<p>No jobs.</p>}>
                <ul class="space-y-2">
                  <For each={data.jobs}>{(job) => (
                    <li class="break-words">{job.title ?? "Title unavailable"} · {job.status} · Created: {timestamp(job.created_at)} · Started: {timestamp(job.started_at)} · Finished: {timestamp(job.finished_at)} · Job #{job.id}</li>
                  )}</For>
                </ul>
              </Show>
            </div>
            <div>
              <h3 class="font-medium">Searches</h3>
              <Show when={data.searches.length} fallback={<p>No searches.</p>}>
                <ul class="space-y-2">
                  <For each={data.searches}>{(search) => (
                    <li class="break-words">{search.query ?? "Query unavailable"} · {search.status} · Created: {timestamp(search.created_at)} · Search {search.id}</li>
                  )}</For>
                </ul>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
};

const UserCard: Component<{ user: AdminUser }> = (props) => {
  const [user, setUser] = createSignal(props.user);
  const [limit, setLimit] = createSignal(props.user.invite_limit === null ? "" : String(props.user.invite_limit));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [showActivity, setShowActivity] = createSignal(false);
  const inputId = `invite-limit-${props.user.id}`;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveLimit = (event: Event) => {
    event.preventDefault();
    const value = limit().trim();
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
      setError("Invite limit must be a non-negative whole number.");
      return;
    }
    void run(async () => {
      await updateAdminUser(user().id, { invite_limit: parsed });
      setUser((current) => ({ ...current, invite_limit: parsed }));
      setLimit(String(parsed));
      setNotice("Invite limit saved.");
    });
  };

  const grantSlot = () => {
    void run(async () => {
      const updated = await grantInviteSlot(user().id);
      setUser(updated);
      setLimit(updated.invite_limit === null ? "" : String(updated.invite_limit));
      setNotice("One invite slot granted.");
    });
  };

  const toggleDisabled = () => {
    const disabled = !user().disabled;
    if (!window.confirm(`${disabled ? "Disable" : "Enable"} ${user().email}?`)) return;
    void run(async () => {
      await updateAdminUser(user().id, { disabled });
      setUser((current) => ({ ...current, disabled }));
      setNotice(disabled ? "Account disabled." : "Account enabled.");
    });
  };

  const revokeSessions = () => {
    if (!window.confirm(`Revoke all sessions for ${user().email}?`)) return;
    void run(async () => {
      await revokeUserSessions(user().id);
      setNotice("Sessions revoked.");
    });
  };

  return (
    <Card>
      <CardContent class="space-y-4 p-4">
        <div>
          <h2 class="break-all font-medium">{user().email}</h2>
          <p class="text-sm text-muted-foreground">
            {user().is_admin ? "Admin · " : ""}{user().disabled ? "Disabled" : "Enabled"}
          </p>
        </div>
        <Show when={user().invite_limit !== null} fallback={<p class="text-sm">Invite limit: Unlimited</p>}>
        <form class="flex flex-wrap items-end gap-2" onSubmit={saveLimit}>
          <div class="space-y-1">
            <label class="block text-sm font-medium" for={inputId}>Invite limit</label>
            <input
              id={inputId}
              class="h-11 w-28 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              type="number"
              min="0"
              step="1"
              required
              value={limit()}
              disabled={busy()}
              onInput={(event) => setLimit(event.currentTarget.value)}
            />
          </div>
          <Button type="submit" size="sm" class="min-h-11" disabled={busy()}>Save limit</Button>
        </form>
          <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={busy()} onClick={grantSlot}>Grant +1 invite</Button>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={busy()} onClick={toggleDisabled}>
            {user().disabled ? "Enable" : "Disable"}
          </Button>
          <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={busy()} onClick={revokeSessions}>
            Revoke sessions
          </Button>
        </div>
        <Button type="button" variant="outline" size="sm" class="min-h-11" aria-expanded={showActivity()} onClick={() => setShowActivity(!showActivity())}>
          {showActivity() ? "Hide activity" : "View activity"}
        </Button>
        <Show when={showActivity()}><Activity userId={user().id} /></Show>
        <Show when={busy()}><p class="text-sm text-muted-foreground" role="status">Saving...</p></Show>
        <Show when={error()}><p class="text-sm text-destructive" role="alert">{error()}</p></Show>
        <Show when={notice()}><p class="text-sm text-muted-foreground" role="status">{notice()}</p></Show>
      </CardContent>
    </Card>
  );
};

const AdminView: Component = () => {
  const [users, setUsers] = createSignal<AdminUser[] | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await adminUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load people.");
    } finally {
      setLoading(false);
    }
  };

  onMount(load);

  return (
    <main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header class="flex items-center justify-between gap-4">
        <h1 class="text-2xl font-semibold tracking-tight">People</h1>
        <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={loading()} onClick={load}>
          {loading() ? "Loading..." : "Refresh"}
        </Button>
      </header>
      <Show when={loading()}><p class="text-sm text-muted-foreground" role="status">Loading people...</p></Show>
      <Show when={error()}><p class="text-sm text-destructive" role="alert">{error()}</p></Show>
      <Show when={users()} keyed>
        {(people) => (
          <Show when={people.length > 0} fallback={<p class="text-sm text-muted-foreground">No people found.</p>}>
            <div class="space-y-3"><For each={people}>{(user) => <UserCard user={user} />}</For></div>
          </Show>
        )}
      </Show>
    </main>
  );
};

export default AdminView;
