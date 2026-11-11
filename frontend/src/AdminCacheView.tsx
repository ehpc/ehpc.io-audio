import { createSignal, For, onMount, Show, type Component } from "solid-js";
import * as AlertDialog from "@kobalte/core/alert-dialog";
import { adminCache, clearAdminCache, type AdminCache } from "./api";
import { Button } from "~/components/button";
import { Card, CardContent } from "~/components/card";

type Target = { ids: string[]; label: string } | { all: true; label: string };
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
  onMount(load);

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
  const blocked = () => loading() || clearing() || !cache() || cache()!.busy || cache()!.unsafe;
  const selectiveBlocked = () => blocked() || !cache()!.selective_ready;

  return (
    <section aria-label="Cached songs" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold">Cached songs</h2>
        <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={loading() || clearing()} onClick={load}>Refresh cache</Button>
      </div>
      <p class="text-sm text-muted-foreground">Manage reusable processing data. Saved jobs and downloads are not removed.</p>
      <Show when={loading()}><p role="status" class="text-sm">Loading cached songs...</p></Show>
      <Show when={error() && !target()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
      <Show when={notice()}><p role="status" class="text-sm">{notice()}</p></Show>
      <Show when={cache()} keyed>{(data) => <>
        <Show when={data.busy}><p class="text-sm" role="status">Active, queued or unresolved work must finish or be reconciled before clearing cache.</p></Show>
        <Show when={data.unsafe}><p class="text-sm text-destructive" role="alert">Cache cannot be safely cleared. Operator attention is required.</p></Show>
        <Show when={!data.selective_ready && !data.unsafe}><p class="text-sm">Some older cache data cannot be attributed to individual songs ({bytes(data.unattributed_bytes)}). Clear all cache before clearing individual songs.</p></Show>
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" class="min-h-11" disabled={selectiveBlocked() || selected().length === 0} onClick={() => setTarget({ ids: [...selected()], label: `${selected().length} selected song${selected().length === 1 ? "" : "s"}` })}>Clear selected ({selected().length})</Button>
          <Button type="button" variant="outline" class="min-h-11" disabled={blocked()} onClick={() => setTarget({ all: true, label: `all reusable cache (${data.songs.length} listed songs and any unattributed data)` })}>Clear all cache</Button>
        </div>
        <Show when={data.songs.length} fallback={<p class="text-sm text-muted-foreground">No cached songs.</p>}>
          <ul class="space-y-2"><For each={data.songs}>{song => <li>
            <Card><CardContent class="flex flex-wrap items-center gap-3 p-3">
              <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input type="checkbox" class="h-5 w-5 shrink-0 accent-primary" checked={selected().includes(song.id)} disabled={selectiveBlocked()}
                  onChange={(event) => setSelected(current => event.currentTarget.checked ? [...current, song.id] : current.filter(id => id !== song.id))} />
                <span class="min-w-0 break-words"><span class="block font-medium">{song.title ?? "Untitled audio"}</span><span class="block text-sm text-muted-foreground">{song.artist ?? "Unknown artist"} · {bytes(song.bytes)}</span></span>
              </label>
              <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={selectiveBlocked()} onClick={() => setTarget({ ids: [song.id], label: song.title ?? "Untitled audio" })} aria-label={`Clear ${song.title ?? "Untitled audio"}`}>Clear</Button>
            </CardContent></Card>
          </li>}</For></ul>
        </Show>
      </>}</Show>
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
    </section>
  );
};

export default AdminCacheView;
