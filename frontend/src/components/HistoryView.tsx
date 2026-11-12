import { createSignal, For, Show, type Component } from "solid-js";
import * as AlertDialog from "@kobalte/core/alert-dialog";
import type { JobDTO, JobStatus } from "~/api";
import { AuthHttpError, deleteJob, jobLabel, retryJob } from "~/api";
import AudioMetadata from "~/components/AudioMetadata";
import { Button } from "~/components/button";
import { Card, CardContent } from "~/components/card";

const STATUS_STYLES: Record<JobStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  done: "bg-green-500/15 text-green-600 dark:text-green-400",
  failed: "bg-destructive/15 text-destructive",
};

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

const HistoryView: Component<{
  jobs: JobDTO[];
  onSelect: (job: JobDTO) => void;
  onRetried: (job: JobDTO) => void;
  onDeleted: (id: number) => void;
}> = (props) => {
  const [retryingId, setRetryingId] = createSignal<number | null>(null);
  const [copiedId, setCopiedId] = createSignal<number | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteTarget, setDeleteTarget] = createSignal<JobDTO | null>(null);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  const copyUrl = async (job: JobDTO, event: MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(job.source_value);
      setCopiedId(job.id);
      setTimeout(() => setCopiedId((id) => (id === job.id ? null : id)), 1500);
    } catch {
      // Clipboard unavailable (e.g. non-secure context); nothing to fall back to.
    }
  };

  const handleRetry = async (job: JobDTO, event: MouseEvent) => {
    event.stopPropagation();
    setRetryingId(job.id);
    try {
      const result = await retryJob(job.id);
      props.onRetried({
        id: result.id,
        status: result.status,
        position: result.position,
        source_type: job.source_type,
        source_value: job.source_value,
        title: job.title,
        original_key: null,
        output_key: null,
        options: job.options,
        manifest: null,
        transcript: null,
        pitch: null,
        error_message: null,
        created_at: Math.floor(Date.now() / 1000),
        has_original: false,
        has_pitch_vocals: false,
      });
    } finally {
      setRetryingId(null);
    }
  };

  const handleDelete = async () => {
    const target = deleteTarget();
    if (!target || deleting()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteJob(target.id);
      setDeleteTarget(null);
      props.onDeleted(target.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete this track. Please try again.";
      const activeFileUse = error instanceof AuthHttpError && error.status === 409
        && error.message === "A job file is currently in use";
      setDeleteError(activeFileUse ? `${message}. Stop playback/downloads for this track, then retry.` : message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
    <section class="space-y-3 border-t border-border pt-6">
      <h2 class="text-sm font-medium text-muted-foreground">History</h2>

      <Show
        when={props.jobs.length > 0}
        fallback={<p class="text-sm text-muted-foreground">No jobs yet.</p>}
      >
        <div class="space-y-2">
          <For each={props.jobs}>
            {(job) => (
              <Card
                class="cursor-pointer transition-colors hover:bg-accent"
                onClick={() => props.onSelect(job)}
              >
                <CardContent class="space-y-2 p-4">
                  <div class="flex items-center justify-between gap-4">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium">{jobLabel(job)}</p>
                      <div class="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{formatTimestamp(job.created_at)}</span>
                        <Show when={job.source_type === "url"}>
                          <span aria-hidden="true">·</span>
                          <button
                            type="button"
                            class="font-medium text-primary hover:underline"
                            onClick={(event) => copyUrl(job, event)}
                          >
                            {copiedId() === job.id ? "Copied!" : "Copy link"}
                          </button>
                        </Show>
                      </div>
                    </div>
                    <span
                      class={`shrink-0 rounded-full px-2 py-0.5 text-xs capitalize ${STATUS_STYLES[job.status]}`}
                    >
                      {job.status}
                    </span>
                  </div>
                  <AudioMetadata job={job} />

                  <Show when={job.status === "done"}>
                    <p class="text-xs text-muted-foreground">
                      {(job.manifest?.length ?? 0)} audio {(job.manifest?.length ?? 0) === 1 ? "output" : "outputs"}
                    </p>
                  </Show>
                  <Show when={job.status === "done"}>
                    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-2 text-sm">
                      <button type="button" class="font-medium text-primary hover:underline"
                        onClick={(event) => { event.stopPropagation(); props.onSelect(job); }}>
                        {job.options.detect_pitch && job.pitch ? "View Karaoke with pitches" : "View results"}
                      </button>
                      <Button type="button" variant="outline" size="sm" class="min-h-11"
                        aria-label={`Delete ${jobLabel(job)}`}
                        onClick={(event) => { event.stopPropagation(); setDeleteError(null); setDeleteTarget(job); }}>
                        Delete
                      </Button>
                    </div>
                  </Show>

                  <Show when={job.status === "failed"}>
                    <div class="flex items-start justify-between gap-3 border-t border-border pt-2">
                      <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-destructive">
                        {job.error_message ?? "An unknown error occurred."}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        class="shrink-0"
                        disabled={retryingId() === job.id}
                        onClick={(event) => handleRetry(job, event)}
                      >
                        {retryingId() === job.id ? "Retrying..." : "Retry"}
                      </Button>
                    </div>
                  </Show>
                </CardContent>
              </Card>
            )}
          </For>
        </div>
      </Show>
    </section>
    <Show when={deleteTarget()}>
      <AlertDialog.Root open onOpenChange={(open) => { if (!open && !deleting()) { setDeleteTarget(null); setDeleteError(null); } }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/70" />
          <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto break-words rounded-lg border border-border bg-background p-5 shadow-lg [overflow-wrap:anywhere]">
            <AlertDialog.Title class="text-lg font-semibold break-words">{`Delete ${jobLabel(deleteTarget()!)}?`}</AlertDialog.Title>
            <AlertDialog.Description class="text-sm text-muted-foreground">
              This permanently deletes this track's history, original audio, saved outputs, and private vocal reference. Shared reusable processing cache is not deleted.
            </AlertDialog.Description>
            <Show when={deleteError()}><p role="alert" class="text-sm text-destructive">{deleteError()}</p></Show>
            <div class="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" class="min-h-11" disabled={deleting()}
                onClick={() => { setDeleteTarget(null); setDeleteError(null); }}>Cancel</Button>
              <Button type="button" variant="destructive" class="min-h-11" disabled={deleting()}
                onClick={() => void handleDelete()}>{deleting() ? "Deleting..." : "Delete track"}</Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </Show>
    </>
  );
};

export default HistoryView;
