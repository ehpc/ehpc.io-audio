import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { adminUsers, revokeUserSessions, updateAdminUser, type AdminUser } from "./api";
import { Button } from "~/components/button";
import { Card, CardContent } from "~/components/card";

const UserCard: Component<{ user: AdminUser }> = (props) => {
  const [user, setUser] = createSignal(props.user);
  const [limit, setLimit] = createSignal(String(props.user.invite_limit));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
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
        <form class="flex flex-wrap items-end gap-2" onSubmit={saveLimit}>
          <div class="space-y-1">
            <label class="block text-sm font-medium" for={inputId}>Invite limit</label>
            <input
              id={inputId}
              class="h-9 w-28 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              type="number"
              min="0"
              step="1"
              required
              value={limit()}
              disabled={busy()}
              onInput={(event) => setLimit(event.currentTarget.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy()}>Save limit</Button>
        </form>
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy()} onClick={toggleDisabled}>
            {user().disabled ? "Enable" : "Disable"}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy()} onClick={revokeSessions}>
            Revoke sessions
          </Button>
        </div>
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
        <Button type="button" variant="outline" size="sm" disabled={loading()} onClick={load}>
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
