import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import * as AlertDialog from "@kobalte/core/alert-dialog";
import {
  adminCache,
  adminCacheRegenerations,
  clearAdminCache,
  regenerateAdminCache,
  type AdminCache,
  type AdminCacheRegeneration,
  type AdminCacheRegenerationChoice,
  type AdminCacheSong,
  type SeparationOptions,
} from "./api";
import { Button } from "~/components/button";
import { Card, CardContent } from "~/components/card";

type Target = { ids: string[]; label: string } | { all: true; label: string };
type RegenerationTarget = { songs: AdminCacheSong[] };
const REGEN_UNAVAILABLE = "No completed job with a verified saved original is available.";
const REGEN_POLL_INTERVAL_MS = 3_000;

const candidateSummary = (options: SeparationOptions) => {
  const enabled = [
    options.extract_vocals && "Vocals",
    options.extract_instruments && "Instruments",
    options.extract_lyrics && "Lyrics",
    options.detect_pitch && "Karaoke with pitches",
    options.extract_pitched_lyrics && "Pitched lyrics",
    options.decrowd && "Decrowd",
    options.decrowd_vocals && "Decrowd vocals",
    options.dereverb && "Dereverb",
    options.genders && "Gender splits",
    options.lead_backing && "Lead/backing",
    options.drums && "Drums",
    ...options.mixes.map(mix => `Mix: ${mix.name}`),
  ].filter((label): label is string => Boolean(label));
  const outputs = enabled.length ? enabled.join(", ") : "Original only";
  const pitch = `${options.pitch_semitones > 0 ? "+" : ""}${options.pitch_semitones} st`;
  return `${outputs} · pitch ${pitch} · tempo ${options.tempo_percent}%`;
};
const statusLabel = (job: AdminCacheRegeneration) => {
  if (job.status === "queued") return `Queued${job.position === null ? "" : ` · position ${job.position}`}`;
  return job.status === "running" ? "Running" : job.status === "done" ? "Completed" : "Failed";
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
  const [regenChoices, setRegenChoices] = createSignal<AdminCacheRegenerationChoice[]>([]);
  const [regenerating, setRegenerating] = createSignal(false);
  const [regenError, setRegenError] = createSignal<string | null>(null);
  const [regenerations, setRegenerations] = createSignal<AdminCacheRegeneration[]>([]);
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
  const scheduleRegenerationRefresh = () => {
    clearTimeout(statusTimer);
    statusTimer = undefined;
    if (!disposed && regenerations().some(item => item.status === "queued" || item.status === "running")) {
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
      const completedActiveJob = refreshed.some(job => {
        const old = previous.find(item => item.job_id === job.job_id);
        return old && (old.status === "queued" || old.status === "running")
          && (job.status === "done" || job.status === "failed");
      });
      setRegenerations(refreshed);
      setRegenerationStatusError(null);
      if (completedActiveJob) await load();
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
  const regenerationBlocked = () => loading() || clearing() || regenerating() || !cache() || cache()!.unsafe;
  const selectedSongs = () => cache()?.songs.filter(song => selected().includes(song.id)) ?? [];
  const openRegeneration = (songs: AdminCacheSong[]) => {
    setRegenTarget({ songs });
    setRegenChoices([]);
    setRegenError(null);
  };
  const toggleCandidate = (song: AdminCacheSong, jobId: number, checked: boolean) => {
    setRegenChoices(current => checked
      ? [...current, { song_id: song.id, job_id: jobId }]
      : current.filter(choice => choice.song_id !== song.id || choice.job_id !== jobId));
  };
  const confirmRegeneration = async () => {
    const currentTarget = regenTarget();
    const choices = regenChoices();
    if (!currentTarget || !choices.length || regenerationBlocked()) return;
    setRegenerating(true);
    setRegenError(null);
    try {
      const created = await regenerateAdminCache({ jobs: choices });
      regenerationRevision += 1;
      const newIds = new Set(created.map(job => job.job_id));
      setRegenerations(current => [...created, ...current.filter(job => !newIds.has(job.job_id))]);
      setRegenTarget(null);
      setRegenChoices([]);
      await load();
      scheduleRegenerationRefresh();
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : "Could not queue regeneration.");
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
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" class="min-h-11" disabled={selectiveBlocked() || selected().length === 0} onClick={() => setTarget({ ids: [...selected()], label: `${selected().length} selected song${selected().length === 1 ? "" : "s"}` })}>Clear selected ({selected().length})</Button>
          <Button type="button" variant="outline" class="min-h-11" disabled={regenerationBlocked() || !selectedSongs().some(song => song.candidates.length > 0)} onClick={() => openRegeneration(selectedSongs())}>Regenerate selected ({selected().length})</Button>
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
                <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={regenerationBlocked() || song.candidates.length === 0} onClick={() => openRegeneration([song])} aria-label={`Regenerate ${song.title ?? "Untitled audio"}`}>Regenerate</Button>
                <Button type="button" variant="outline" size="sm" class="min-h-11" disabled={selectiveBlocked()} onClick={() => setTarget({ ids: [song.id], label: song.title ?? "Untitled audio" })} aria-label={`Clear ${song.title ?? "Untitled audio"}`}>Clear</Button>
              </div>
              <Show when={song.candidates.length === 0}><p class="w-full text-xs text-muted-foreground">{REGEN_UNAVAILABLE}</p></Show>
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
            <For each={regenerations()}>{job => {
              const title = () => cache()?.songs.find(song => song.id === job.song_id)?.title ?? "Cached song";
              return <li class="rounded-md bg-muted/40 p-2">
                <p class="font-medium">{title()}</p>
                <p role="status" class="text-sm text-muted-foreground">Job #{job.job_id} · {statusLabel(job)}</p>
                <Show when={job.status === "failed" && job.error_message}>
                  <p role="alert" class="text-sm text-destructive">{job.error_message}</p>
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
          setRegenChoices([]);
          setRegenError(null);
        }
      }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/70" />
          <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg">
            <AlertDialog.Title class="text-lg font-semibold">Choose configurations to regenerate</AlertDialog.Title>
            <AlertDialog.Description class="text-sm text-muted-foreground">
              This queues new jobs from the selected completed configurations and their verified saved originals. New versions appear in the original owners’ Library; existing jobs and downloads stay. Compatible caches are reused; changed or missing versions may incur GPU costs.
            </AlertDialog.Description>
            <div class="space-y-3">
              <For each={regenTarget()?.songs ?? []}>{song =>
                <fieldset class="space-y-2 rounded-md border border-border p-3">
                  <legend class="px-1 font-medium">{song.title ?? "Untitled audio"} · {song.artist ?? "Unknown artist"}</legend>
                  <Show when={song.candidates.length > 0} fallback={<p class="text-sm text-muted-foreground">{REGEN_UNAVAILABLE}</p>}>
                    <div class="space-y-2">
                      <For each={song.candidates}>{candidate =>
                        <label class="flex min-w-0 cursor-pointer items-start gap-3 rounded-md bg-muted/40 p-3">
                          <input
                            type="checkbox"
                            class="mt-1 h-5 w-5 shrink-0 accent-primary"
                            checked={regenChoices().some(choice => choice.song_id === song.id && choice.job_id === candidate.job_id)}
                            disabled={regenerationBlocked()}
                            aria-label={`Regenerate ${song.title ?? "Untitled audio"} from job ${candidate.job_id}: ${candidateSummary(candidate.options)}`}
                            onChange={event => toggleCandidate(song, candidate.job_id, event.currentTarget.checked)}
                          />
                          <span class="min-w-0 break-words">
                            <span class="block font-medium">Completed job #{candidate.job_id}</span>
                            <span class="block text-sm text-muted-foreground">{candidateSummary(candidate.options)}</span>
                          </span>
                        </label>
                      }</For>
                    </div>
                  </Show>
                </fieldset>
              }</For>
            </div>
            <Show when={regenError()}><p role="alert" class="text-sm text-destructive">{regenError()}</p></Show>
            <div class="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" class="min-h-11" disabled={regenerating()} onClick={() => {
                setRegenTarget(null);
                setRegenChoices([]);
                setRegenError(null);
              }}>Cancel</Button>
              <Button type="button" variant="default" class="min-h-11" disabled={regenerationBlocked() || regenChoices().length === 0} onClick={() => void confirmRegeneration()}>
                {regenerating() ? "Queueing..." : "Queue regeneration"}
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
