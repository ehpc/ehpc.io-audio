import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { JobStatus, RecentJob, StatusDTO } from "./api";
import { getStatus } from "./api";
import { Button } from "~/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";

const STATUS_STYLES: Record<JobStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  done: "bg-green-500/15 text-green-600 dark:text-green-400",
  failed: "bg-destructive/15 text-destructive",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

const StatCard: Component<{ label: string; value: string }> = (props) => (
  <Card>
    <CardContent class="p-4">
      <p class="text-xs text-muted-foreground">{props.label}</p>
      <p class="text-2xl font-semibold tabular-nums">{props.value}</p>
    </CardContent>
  </Card>
);

const StatusPage: Component = () => {
  const [status, setStatus] = createSignal<StatusDTO | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const load = async () => {
    setLoading(true);
    try {
      setStatus(await getStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status.");
    } finally {
      setLoading(false);
    }
  };

  onMount(load);

  const usedPct = () => {
    const d = status()?.disk;
    return d && d.total_bytes ? Math.round((d.used_bytes / d.total_bytes) * 100) : 0;
  };

  return (
    <main class="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header class="flex items-center justify-between gap-4">
        <h1 class="text-2xl font-semibold tracking-tight">Status</h1>
        <Button variant="outline" size="sm" disabled={loading()} onClick={load}>
          {loading() ? "Refreshing..." : "Refresh"}
        </Button>
      </header>

      <Show when={error()}>
        <p class="text-sm text-destructive">{error()}</p>
      </Show>

      <Show when={status()} keyed>
        {(s) => (
          <>
            <section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Total jobs" value={String(s.total_jobs)} />
              <StatCard label="Running" value={String(s.counts.running ?? 0)} />
              <StatCard label="Queued" value={String(s.counts.queued ?? 0)} />
              <StatCard
                label="Concurrency"
                value={String(s.queue_concurrency)}
              />
            </section>

            <Card>
              <CardHeader>
                <CardTitle class="text-base">Disk usage (/data)</CardTitle>
              </CardHeader>
              <CardContent class="space-y-3">
                <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    class="h-full bg-primary"
                    style={{ width: `${usedPct()}%` }}
                  />
                </div>
                <p class="text-sm text-muted-foreground">
                  {formatBytes(s.disk.used_bytes)} used of{" "}
                  {formatBytes(s.disk.total_bytes)} ({usedPct()}%) —{" "}
                  {formatBytes(s.disk.free_bytes)} free
                </p>
                <dl class="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt class="text-xs text-muted-foreground">Result stems</dt>
                    <dd class="tabular-nums">{formatBytes(s.disk.results_bytes)}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted-foreground">Database</dt>
                    <dd class="tabular-nums">{formatBytes(s.disk.db_bytes)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <section class="space-y-3">
              <h2 class="text-sm font-medium text-muted-foreground">
                Recent jobs (all sessions)
              </h2>
              <Show
                when={s.recent.length > 0}
                fallback={<p class="text-sm text-muted-foreground">No jobs yet.</p>}
              >
                <div class="space-y-2">
                  <For each={s.recent}>
                    {(job: RecentJob) => (
                      <Card>
                        <CardContent class="flex items-center justify-between gap-4 p-3">
                          <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-medium">
                              {job.title ?? job.source_value}
                            </p>
                            <p class="text-xs text-muted-foreground">
                              #{job.id} · {formatTimestamp(job.created_at)}
                            </p>
                          </div>
                          <span
                            class={`shrink-0 rounded-full px-2 py-0.5 text-xs capitalize ${STATUS_STYLES[job.status]}`}
                          >
                            {job.status}
                          </span>
                        </CardContent>
                      </Card>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            <p class="text-xs text-muted-foreground">
              Modal app: <span class="font-mono">{s.modal_app}</span> ·{" "}
              <a
                href="https://modal.com/apps"
                target="_blank"
                rel="noreferrer"
                class="text-primary hover:underline"
              >
                GPU usage & billing on the Modal dashboard
              </a>
            </p>
          </>
        )}
      </Show>
    </main>
  );
};

export default StatusPage;
