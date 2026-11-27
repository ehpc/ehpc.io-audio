import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from "solid-js";
import type { JobDTO, SongDetail, SongOutputRef, SongVariant } from "~/api";
import { getJob, jobLabel, originalUrl, playbackUrl, resultUrl } from "~/api";
import { Button } from "~/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import AudioMetadata from "~/components/AudioMetadata";
import KeyNotes from "~/components/KeyNotes";
import OutputIcon from "~/components/OutputIcon";
import TranscriptView from "~/components/TranscriptView";
import PitchView from "~/components/PitchView";
import PitchedLyricsView from "~/components/PitchedLyricsView";

export type HistoryScrollRequest = { jobId: number; token: number };

type Choice = { variant: SongVariant; output: SongOutputRef };
const variantKey = (variant: SongVariant) => `${variant.pitch_semitones}:${variant.tempo_percent}`;
const variantLabel = (variant: SongVariant) => `Pitch ${variant.pitch_semitones >= 0 ? "+" : ""}${variant.pitch_semitones} · Tempo ${variant.tempo_percent}%`;
const durationLabel = (seconds: number) => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const StemCard: Component<{ identity: string; choices: Choice[]; originalKey?: string | null }> = props => {
  const [selected, setSelected] = createSignal(variantKey(props.choices[0].variant));
  const choice = () => props.choices.find(item => variantKey(item.variant) === selected()) ?? props.choices[0];
  const url = () => resultUrl(choice().output.work_id, choice().output.label, choice().output.revision);
  return <Card>
    <CardHeader>
      <CardTitle class="flex items-center justify-between gap-4 text-base">
        <span class="flex items-center gap-2"><OutputIcon label={choice().output.display_name} identity={props.identity} />{choice().output.display_name}</span>
        <span class="text-xs font-normal text-muted-foreground">{durationLabel(choice().output.manifest.duration_s)} · {(choice().output.manifest.size_bytes / 1048576).toFixed(1)} MB</span>
      </CardTitle>
      <Show when={props.originalKey}>{key => <p class="text-sm text-muted-foreground">Source key: {key()}</p>}</Show>
      <Show when={props.choices.length > 1} fallback={<p class="text-xs text-muted-foreground">{variantLabel(choice().variant)}</p>}>
        <label>Version <select aria-label={`${choice().output.display_name} version`} value={variantKey(choice().variant)} onChange={event => setSelected(event.currentTarget.value)}>
          <For each={props.choices}>{item => <option value={variantKey(item.variant)}>{variantLabel(item.variant)}</option>}</For>
        </select></label>
      </Show>
    </CardHeader>
    <CardContent class="space-y-3">
      <audio controls preload="none" class="w-full" src={playbackUrl(url())} />
      <a href={url()} download={choice().output.manifest.download_name} class="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">Download {choice().output.manifest.download_name}</a>
    </CardContent>
  </Card>;
};

const ResultsView: Component<{ detail: SongDetail; onReset: () => void; scrollRequest?: HistoryScrollRequest | null; refreshToken: number; onStaleDetail: (songId: number) => void }> = props => {
  const [karaokeKey, setKaraokeKey] = createSignal("");
  const [pitchedKey, setPitchedKey] = createSignal("");
  const [works, setWorks] = createSignal<Record<string, JobDTO>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const pending = new Map<string, number>();
  let loadEpoch = 0;
  let refreshToken = props.refreshToken;
  let container!: HTMLDivElement;
  let consumedScrollToken: number | null = null;
  let disposed = false;
  onCleanup(() => { disposed = true; container.querySelectorAll("audio").forEach(audio => audio.pause()); });
  const karaokeVariants = () => props.detail.variants.filter(v => v.karaoke_work_id !== null);
  const karaoke = () => karaokeVariants().find(v => variantKey(v) === karaokeKey()) ?? karaokeVariants()[0];
  const pitchedVariants = () => props.detail.variants.filter(v => v.pitched_lyrics_work_id !== null);
  const pitched = () => pitchedVariants().find(v => variantKey(v) === pitchedKey()) ?? pitchedVariants()[0];
  const lyrics = () => props.detail.variants.reduce<SongVariant | undefined>((latest, variant) =>
    variant.lyrics_work_id !== null && (latest?.lyrics_work_id == null || variant.lyrics_work_id > latest.lyrics_work_id) ? variant : latest, undefined);
  const cacheKey = (id: number | null | undefined, revision: string | null | undefined) => id == null ? "" : JSON.stringify(revision === undefined ? [id] : [id, revision]);
  const work = (id: number | null | undefined, revision: string | null | undefined) => works()[cacheKey(id, revision)];
  const requestedRefs = () => {
    const k = karaoke(), p = pitched(), l = lyrics();
    return [
      [k?.karaoke_work_id, k?.karaoke_revision], [p?.pitched_lyrics_work_id, p?.pitched_lyrics_revision],
      [l?.lyrics_work_id, l?.lyrics_revision], [k ? null : props.detail.summary.original_work_id, undefined],
    ] as [number | null | undefined, string | null | undefined][];
  };
  createEffect(() => {
    const token = props.refreshToken;
    if (token !== refreshToken) {
      refreshToken = token;
      loadEpoch++;
      setErrors({});
    }
  });
  createEffect(() => {
    const refs = requestedRefs();
    const epoch = loadEpoch;
    for (const [id, revision] of refs) {
      const key = cacheKey(id, revision);
      if (id == null || works()[key] || errors()[key] || pending.get(key) === epoch) continue;
      pending.set(key, epoch);
      const songId = props.detail.summary.id;
      void getJob(id).then(job => {
        if (disposed || epoch !== loadEpoch) return;
        if (revision !== undefined && (job.result_revision ?? null) !== revision) {
          if (!requestedRefs().some(([currentId, currentRevision]) => cacheKey(currentId, currentRevision) === key)) return;
          setErrors(existing => ({ ...existing, [key]: "The saved output changed. Refresh this song to load its current version." }));
          props.onStaleDetail(songId);
          return;
        }
        setWorks(existing => ({ ...existing, [key]: job }));
      }).catch(error => {
        if (!disposed && epoch === loadEpoch) setErrors(existing => ({ ...existing, [key]: error instanceof Error ? error.message : "Could not load output." }));
      }).finally(() => {
        if (pending.get(key) === epoch) pending.delete(key);
      });
    }
  });
  const karaokeJob = () => {
    const variant = karaoke();
    return variant ? work(variant.karaoke_work_id, variant.karaoke_revision) : undefined;
  };
  const sourceKey = () => props.detail.summary.original_key ?? karaokeJob()?.original_key ??
    work(props.detail.summary.original_work_id, undefined)?.original_key ??
    work(lyrics()?.lyrics_work_id, lyrics()?.lyrics_revision)?.original_key ??
    work(pitched()?.pitched_lyrics_work_id, pitched()?.pitched_lyrics_revision)?.original_key ?? null;
  const grouped = createMemo(() => {
    const groups = new Map<string, Choice[]>();
    for (const variant of props.detail.variants) for (const output of variant.outputs) {
      const choices = groups.get(output.identity) ?? [];
      choices.push({ variant, output });
      groups.set(output.identity, choices);
    }
    return groups;
  });
  const identities = createMemo(() => Array.from(grouped().keys()));
  createEffect(() => {
    const request = props.scrollRequest;
    if (!request || request.jobId !== props.detail.summary.id || request.token === consumedScrollToken) return;
    const variant = karaoke();
    if (variant && !karaokeJob() && !errors()[cacheKey(variant.karaoke_work_id, variant.karaoke_revision)]) return;
    consumedScrollToken = request.token;
    queueMicrotask(() => {
      if (!container.isConnected || props.scrollRequest?.token !== request.token) return;
      (container.querySelector<HTMLElement>("#karaoke") ?? container).scrollIntoView({ behavior: "instant", block: "start" });
    });
  });
  return <div ref={container} class="results-panel space-y-6 pb-4">
    <h2 class="break-words text-lg font-semibold [overflow-wrap:anywhere]">{jobLabel(props.detail.summary)}</h2>
    <Show when={karaokeJob()}>{job => <AudioMetadata job={job()} />}</Show>
    <Show when={!karaokeJob() && (sourceKey() || work(props.detail.summary.original_work_id, undefined))}>
      <p class="text-xs text-muted-foreground">Original key: {sourceKey() ?? "Undetermined"}<KeyNotes musicalKey={sourceKey()} /></p>
    </Show>
    <Show when={karaokeVariants().length > 0}>
      <section id="song-karaoke" tabIndex={-1}>
        <Show when={karaokeVariants().length > 1}><label>Karaoke version <select aria-label="Karaoke version" value={variantKey(karaoke()!)} onChange={event => setKaraokeKey(event.currentTarget.value)}><For each={karaokeVariants()}>{variant => <option value={variantKey(variant)}>{variantLabel(variant)}</option>}</For></select></label></Show>
        <Show when={karaokeJob()} fallback={<Show when={!errors()[cacheKey(karaoke()?.karaoke_work_id, karaoke()?.karaoke_revision)]}><p role="status">Loading karaoke…</p></Show>}>{job => <Card><CardContent class="min-w-0 p-4"><PitchView job={job()} outputs={karaoke()?.outputs ?? []} originalWorkId={props.detail.summary.original_work_id} /></CardContent></Card>}</Show>
      </section>
    </Show>
    <Show when={pitchedVariants().length > 0}>
      <section id="song-pitched-lyrics" tabIndex={-1}>
        <Show when={pitchedVariants().length > 1}><label>Lyrics with pitches version <select aria-label="Pitched lyrics version" value={variantKey(pitched()!)} onChange={event => setPitchedKey(event.currentTarget.value)}><For each={pitchedVariants()}>{variant => <option value={variantKey(variant)}>{variantLabel(variant)}</option>}</For></select></label></Show>
        <Show when={work(pitched()?.pitched_lyrics_work_id, pitched()?.pitched_lyrics_revision)} fallback={<Show when={!errors()[cacheKey(pitched()?.pitched_lyrics_work_id, pitched()?.pitched_lyrics_revision)]}><p role="status">Loading lyrics with pitches…</p></Show>}>{job => <Card><CardContent class="min-w-0 p-4"><PitchedLyricsView job={job()} /></CardContent></Card>}</Show>
      </section>
    </Show>
    <Show when={lyrics()}>{variant => <section id="song-lyrics" tabIndex={-1}><Show when={work(variant().lyrics_work_id, variant().lyrics_revision)} fallback={<Show when={!errors()[cacheKey(variant().lyrics_work_id, variant().lyrics_revision)]}><p role="status">Loading lyrics…</p></Show>}>{job => <Card><CardContent class="p-4"><TranscriptView job={job()} /></CardContent></Card>}</Show></section>}</Show>
    <Show when={props.detail.summary.has_original || grouped().size > 0}><section id="song-audio" tabIndex={-1} class="space-y-4">
      <Show when={props.detail.summary.has_original && props.detail.summary.original_work_id !== null}><Card><CardHeader><CardTitle class="flex items-center gap-2 text-base"><OutputIcon label="Original" identity="original" />Original</CardTitle></CardHeader><CardContent class="space-y-3"><audio controls preload="none" class="w-full" src={playbackUrl(originalUrl(props.detail.summary.original_work_id!))} /><a href={originalUrl(props.detail.summary.original_work_id!)} download="" class="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">Download original</a></CardContent></Card></Show>
      <For each={identities()}>{identity => <StemCard identity={identity} choices={grouped().get(identity)!} originalKey={sourceKey()} />}</For>
    </section></Show>
    <For each={requestedRefs().map(([id, revision]) => errors()[cacheKey(id, revision)]).filter((message): message is string => Boolean(message)).filter((message, index, all) => all.indexOf(message) === index)}>{message => <p role="alert">Could not load output: {message}</p>}</For>
    <Button variant="outline" onClick={props.onReset}>Start another job</Button>
  </div>;
};

export default ResultsView;
