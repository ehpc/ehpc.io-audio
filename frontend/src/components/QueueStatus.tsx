import { createEffect, createSignal, on, onCleanup, Show, type Component } from "solid-js";
import type { JobDTO } from "~/api";
import { getJob, jobLabel, subscribeToJob } from "~/api";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";

const QueueStatus: Component<{
  job: JobDTO;
  onTerminal: (job: JobDTO) => void;
}> = (props) => {
  const [job, setJob] = createSignal<JobDTO>(props.job);

  const apply = (next: JobDTO) => {
    setJob(next);
    if (next.status === "done" || next.status === "failed") {
      props.onTerminal(next);
    }
  };

  // Re-subscribes whenever the focused job changes (e.g. selecting a
  // different queued/running job from history), not just on first mount.
  createEffect(
    on(
      () => props.job.id,
      (id) => {
        setJob(props.job);
        const unsubscribe = subscribeToJob(id, apply, async () => {
          // The stream dropped without a terminal event; one snapshot recovers
          // the current state so the view never stays stuck on a stale status.
          try {
            apply(await getJob(id));
          } catch {
            // Leave the last known status in place if the fallback also fails.
          }
        });
        onCleanup(unsubscribe);
      },
    ),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Processing: {jobLabel(job())}</CardTitle>
      </CardHeader>
      <CardContent>
        <Show
          when={job().status === "queued"}
          fallback={
            <div class="flex items-center gap-3 text-sm text-muted-foreground">
              <span
                class="size-5 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
                aria-hidden="true"
              />
              <span>Running separation, this can take a few minutes...</span>
            </div>
          }
        >
          <div class="space-y-1">
            <p class="text-3xl font-semibold tabular-nums">
              #{job().position ?? "-"}
            </p>
            <p class="text-sm text-muted-foreground">Your position in the queue</p>
          </div>
        </Show>
      </CardContent>
    </Card>
  );
};

export default QueueStatus;
