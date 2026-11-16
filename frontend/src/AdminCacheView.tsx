import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import * as AlertDialog from "@kobalte/core/alert-dialog";
import {
  adminCache,
  adminCacheRegenerations,
  clearAdminCache,
  regenerateAdminCache,
  type AdminCache,
  type AdminCacheSong,
  type SongRegeneration,
} from "./api";
import { Button } from "~/components/button";
import { Card, CardContent } from "~/components/card";

type Target = { ids: string[]; label: string } | { all: true; label: string };
type RegenerationTarget = { songs: AdminCacheSong[] };
const REGEN_POLL_INTERVAL_MS = 3_000;

const statusLabel = (operation: SongRegeneration) => {
  if (operation.status === "queued") return "Queued";
  if (operation.status === "clearing") return "Clearing cache";
  if (operation.status === "running") return "Regenerating";
  return operation.status === "done" ? "Completed" : "Failed";
};
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024
  ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`;

const AdminCacheView: Component = () => {
  const [cache, setCache] = createSignal<AdminCache | null>(null);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);
  const [target, setTarget] = createSignal<Target | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [regenTarget, setRegenTarget] = createSignal<RegenerationTarget | null>(null);
  const [regenerating, setRegenerating] = createSignal(false);
  const [regenError, setRegenError] = createSignal<string | null>(null);
  const [regenerations, setRegenerations] = createSignal<SongRegeneration[]>([]);
  const [refreshingRegenerations, setRefreshingRegenerations] = createSignal(false);
  const [regenerationStatusError, setRegenerationStatusError] = createSignal<string | null>(null);
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let statusRequestActive = false;
  let regenerationRevision = 0;
  let disposed = false;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminCache();
      setCache(result);
      setSelected(current => current.filter(id => result.songs.some(song => song.id === id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load cached songs.");
    } finally {
      setLoading(false);
    }
  };
  const operationActive = (operation: SongRegeneration) => operation.status === "queued"
    || operation.status === "clearing" || operation.status === "running";
  const scheduleRegenerationRefresh = () => {
    clearTimeout(statusTimer);
    statusTimer = undefined;
    if (!disposed && regenerations().some(operationActive)) {
      statusTimer = setTimeout(() => {
        statusTimer = undefined;
        void refreshRegenerations();
      }, REGEN_POLL_INTERVAL_MS);
    }
  };
  const refreshRegenerations = async () => {
    if (disposed || statusRequestActive) return;
    clearTimeout(statusTimer);
    statusTimer = undefined;
    statusRequestActive = true;
    setRefreshingRegenerations(true);
    const requestRevision = regenerationRevision;
    try {
      const previous = regenerations();
      const refreshed = await adminCacheRegenerations();
      if (requestRevision !== regenerationRevision) return;
      const completedActiveOperation = refreshed.some(operation => {
        const old = previous.find(item => item.operation_id === operation.operation_id);
        return old && operationActive(old) && !operationActive(operation);
      });
      setRegenerations(refreshed);
      setRegenerationStatusError(null);
      if (completedActiveOperation) await load();
    } catch (err) {
      if (requestRevision === regenerationRevision) {
        setRegenerationStatusError(err instanceof Error ? err.message : "Could not refresh regeneration status.");
      }
    } finally {
      statusRequestActive = false;
      setRefreshingRegenerations(false);
      scheduleRegenerationRefresh();
    }
  };
  onCleanup(() => {
    disposed = true;
    clearTimeout(statusTimer);
  });
  onMount(() => {
    void load();
    void refreshRegenerations();
  });

  const confirm = async () => {
    const current = target();
    if (!current || clearing()) return;
    setClearing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await clearAdminCache("all" in current ? { all: true } : { ids: current.ids });
      setTarget(null);
      setSelected([]);
      setNotice(`Cleared ${result.cleared} cache file${result.cleared === 1 ? "" : "s"}; reclaimed ${bytes(result.reclaimed_bytes)}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear cache.");
    } finally {
      setClearing(false);
    }
  };
  const blocked = () => loading() || clearing() || regenerating() || !cache() || cache()!.busy || cache()!.unsafe;
  const selectiveBlocked = () => blocked() || !cache()!.selective_ready;
  const regenerationBlocked = () => blocked() || !cache()!.selective_ready;
  const selectedSongs = () => cache()?.songs.filter(song => selected().includes(song.id)) ?? [];
  const selectedSongsRegenerable = () => {
    const songs = selectedSongs();
    return songs.length > 0 && songs.every(song => song.regenerable && song.matched_jobs > 0);
  };
  const openRegeneration = (songs: AdminCacheSong[]) => {
    setRegenTarget({ songs });
    setRegenError(null);
  };
  const confirmRegeneration = async () => {
    const currentTarget = regenTarget();
    const ids = currentTarget?.songs.map(song => song.id) ?? [];
    if (!currentTarget || ids.length === 0 || currentTarget.songs.some(song => !song.regenerable || song.matched_jobs === 0)
      || regenerationBlocked()) return;
    setRegenerating(true);
    setRegenError(null);
    try {
      const created = await regenerateAdminCache({ ids });
      const requestRevision = ++regenerationRevision;
      const newIds = new Set(created.map(operation => operation.operation_id));
      setRegenerations(current => [...created, ...current.filter(operation => !newIds.has(operation.operation_id))]);
      setRegenTarget(null);
      await load();
      if (requestRevision === regenerationRevision) scheduleRegenerationRefresh();
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : "Could not start song regeneration.");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <section aria-label="Cached songs" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold">Cached songs</h2>
        <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={loading() || clearing() || regenerating()} onClick={load}>Refresh cache</Button>
      </div>
      <p class="text-sm text-muted-foreground">Manage reusable processing data. Saved jobs and downloads are not removed.</p>
      <Show when={loading()}><p role="status" class="text-sm">Loading cached songs...</p></Show>
      <Show when={error() && !target()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
      <Show when={notice()}><p role="status" class="text-sm">{notice()}</p></Show>
      <Show when={cache()} keyed>{(data) => <>
        <Show when={data.busy}><p class="text-sm" role="status">Active, queued or unresolved work must finish or be reconciled before clearing cache.</p></Show>
        <Show when={data.unsafe}><p class="text-sm text-destructive" role="alert">Cache cannot be safely cleared. Operator attention is required.</p></Show>
        <Show when={!data.selective_ready && !data.unsafe}><p class="text-sm">Some older cache data cannot be attributed to individual songs ({bytes(data.unattributed_bytes)}). Clear all cache before clearing individual songs.</p></Show>
        <Show when={data.unmatched_completed_jobs > 0}>
          <p role="status" class="text-sm text-muted-foreground">
            {data.unmatched_completed_jobs} completed job{data.unmatched_completed_jobs === 1 ? " has" : "s have"} no safely matched original and cannot be regenerated from this list.
          </p>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" class="min-h-11" disabled={selectiveBlocked() || selected().length === 0} onClick={() => setTarget({ ids: [...selected()], label: `${selected().length} selected song${selected().length === 1 ? "" : "s"}` })}>Clear selected ({selected().length})</Button>
          <Button type="button" variant="outline" class="min-h-11" disabled={regenerationBlocked() || !selectedSongsRegenerable()} onClick={() => openRegeneration(selectedSongs())}>Regenerate selected ({selected().length})</Button>
          <Button type="button" variant="outline" class="min-h-11" disabled={blocked()} onClick={() => setTarget({ all: true, label: `all reusable cache (${data.songs.length} listed songs and any unattributed data)` })}>Clear all cache</Button>
        </div>
        <Show when={data.songs.length} fallback={<p class="text-sm text-muted-foreground">No cached songs.</p>}>
          <ul class="space-y-2"><For each={data.songs}>{song => <li>
            <Card><CardContent class="flex flex-wrap items-center gap-3 p-3">
              <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input type="checkbox" class="h-5 w-5 shrink-0 accent-primary" checked={selected().includes(song.id)} disabled={regenerationBlocked()}
                  onChange={(event) => setSelected(current => event.currentTarget.checked ? [...current, song.id] : current.filter(id => id !== song.id))} />
                <span class="min-w-0 break-words"><span class="block font-medium">{song.title ?? "Untitled audio"}</span><span class="block text-sm text-muted-foreground">{song.artist ?? "Unknown artist"} · {bytes(song.bytes)}</span></span>
              </label>
              <div class="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={regenerationBlocked() || !song.regenerable || song.matched_jobs === 0} onClick={() => openRegeneration([song])} aria-label={`Regenerate ${song.title ?? "Untitled audio"}`}>Regenerate</Button>
                <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={selectiveBlocked()} onClick={() => setTarget({ ids: [song.id], label: song.title ?? "Untitled audio" })} aria-label={`Clear ${song.title ?? "Untitled audio"}`}>Clear</Button>
              </div>
              <Show when={song.regenerable && song.matched_jobs > 0}>
                <p class="w-full text-xs text-muted-foreground">{song.matched_jobs} saved job variant{song.matched_jobs === 1 ? "" : "s"} will be regenerated.</p>
              </Show>
              <Show when={!song.regenerable}>
                <p class="w-full text-xs text-muted-foreground">{song.unavailable_reason ?? "No verified saved original is available for this song."}</p>
              </Show>
            </CardContent></Card>
          </li>}</For></ul>
        </Show>
      </>}</Show>
      <Show when={regenerations().length > 0 || regenerationStatusError()}>
        <section aria-label="Regeneration status" class="space-y-2 rounded-lg border border-border p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-semibold">Regeneration activity</h3>
            <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={refreshingRegenerations()} onClick={() => void refreshRegenerations()}>
              {refreshingRegenerations() ? "Refreshing..." : "Refresh regeneration status"}
            </Button>
          </div>
          <Show when={regenerationStatusError()}><p role="alert" class="text-sm text-destructive">{regenerationStatusError()}</p></Show>
          <ul class="space-y-2">
            <For each={regenerations()}>{operation => {
              const title = () => operation.title ?? cache()?.songs.find(song => song.id === operation.song_id)?.title ?? "Cached song";
              return <li class="rounded-md bg-muted/40 p-2">
                <p class="font-medium">{title()}</p>
                <p role="status" class="text-sm text-muted-foreground">{statusLabel(operation)}</p>
                <p class="text-xs text-muted-foreground">{operation.completed_jobs} of {operation.total_jobs} saved job variant{operation.total_jobs === 1 ? "" : "s"} completed.</p>
                <Show when={operation.status === "failed" && operation.error_message}>
                  <p role="alert" class="text-sm text-destructive">{operation.error_message}</p>
                </Show>
              </li>;
            }}</For>
          </ul>
        </section>
      </Show>
      <Show when={target()}>
      <AlertDialog.Root open onOpenChange={open => { if (!open && !clearing()) { setTarget(null); setError(null); } }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/70" />
          <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-lg border border-border bg-background p-5 shadow-lg">
            <AlertDialog.Title class="text-lg font-semibold">Clear {target()?.label}?</AlertDialog.Title>
            <AlertDialog.Description class="text-sm text-muted-foreground">Future processing may need to download or recompute data and may incur GPU costs. Shared cached work may also be removed for other songs. Saved jobs, downloads, karaoke reference audio, accounts and model weights are preserved.</AlertDialog.Description>
            <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
            <div class="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" class="min-h-11" disabled={clearing()} onClick={() => { setTarget(null); setError(null); }}>Cancel</Button>
              <Button type="button" variant="destructive" class="min-h-11" disabled={clearing()} onClick={() => void confirm()}>{clearing() ? "Clearing..." : "Confirm clear"}</Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      </Show>
      <Show when={regenTarget()}>
      <AlertDialog.Root open onOpenChange={open => {
        if (!open && !regenerating()) {
          setRegenTarget(null);
          setRegenError(null);
        }
      }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/70" />
          <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg">
            <AlertDialog.Title class="text-lg font-semibold">
              Regenerate {regenTarget()?.songs.length ?? 0} song{regenTarget()?.songs.length === 1 ? "" : "s"}?
            </AlertDialog.Title>
            <AlertDialog.Description class="text-sm text-muted-foreground">
              This clears reusable cache for the selected songs and regenerates every safely matched saved variant across all owners and settings. Each successful result atomically replaces the existing job’s outputs, so the same Library entry is updated without duplicates. Existing results remain available until their replacement is published; if a variant fails, its previous result remains. Shared cached work may be evicted, and rebuilding it may incur GPU costs.
            </AlertDialog.Description>
            <ul class="space-y-2">
              <For each={regenTarget()?.songs ?? []}>{song =>
                <li class="rounded-md border border-border p-3">
                  <p class="font-medium">{song.title ?? "Untitled audio"} · {song.artist ?? "Unknown artist"}</p>
                  <p class="text-sm text-muted-foreground">{song.matched_jobs} saved job variant{song.matched_jobs === 1 ? "" : "s"} across all owners and settings.</p>
                </li>
              }</For>
            </ul>
            <Show when={regenError()}><p role="alert" class="text-sm text-destructive">{regenError()}</p></Show>
            <div class="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" class="min-h-11" disabled={regenerating()} onClick={() => {
                setRegenTarget(null);
                setRegenError(null);
              }}>Cancel</Button>
              <Button type="button" variant="default" class="min-h-11"
                disabled={regenerationBlocked() || (regenTarget()?.songs.some(song => !song.regenerable || song.matched_jobs === 0) ?? true)}
                onClick={() => void confirmRegeneration()}>
                {regenerating() ? "Starting..." : "Clear cache and regenerate"}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      </Show>
    </section>
  );
};

export default AdminCacheView;
