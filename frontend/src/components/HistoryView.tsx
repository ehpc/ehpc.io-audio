import { createSignal, For, Show, type Component } from "solid-js";
import type { JobDTO, JobStatus } from "~/api";
import { jobLabel, originalUrl, resultUrl, retryJob } from "~/api";
import { displayOutputLabel } from "~/lib/expectedStems";
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
}> = (props) => {
  const [retryingId, setRetryingId] = createSignal<number | null>(null);
  const [copiedId, setCopiedId] = createSignal<number | null>(null);

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
        error_message: null,
        created_at: Math.floor(Date.now() / 1000),
        has_original: false,
      });
    } finally {
      setRetryingId(null);
    }
  };

  return (
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

                  <Show when={job.status === "done" && (job.has_original || (job.manifest?.length ?? 0) > 0)}>
                    <div class="flex flex-wrap gap-1.5 border-t border-border pt-2">
                      <Show when={job.has_original}>
                        <a
                          href={originalUrl(job.id)}
                          download=""
                          onClick={(event) => event.stopPropagation()}
                          class="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-foreground hover:bg-accent hover:underline"
                        >
                          {displayOutputLabel("original", job.options)}
                        </a>
                      </Show>
                      <For each={job.manifest ?? []}>
                        {(stem) => (
                          <a
                            href={resultUrl(job.id, stem.label)}
                            download={stem.download_name}
                            title={stem.download_name}
                            onClick={(event) => event.stopPropagation()}
                            class="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-foreground hover:bg-accent hover:underline"
                          >
                            {displayOutputLabel(stem.label, job.options)}
                            <Show when={job.original_key}>
                              <span class="ml-1.5 normal-case">Source key: {job.original_key}</span>
                            </Show>
                          </a>
                        )}
                      </For>
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
  );
};

export default HistoryView;
