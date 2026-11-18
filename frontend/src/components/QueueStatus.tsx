import { Show, type Component } from "solid-js";
import type { JobDTO } from "~/api";
import { jobLabel } from "~/api";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";

const QueueStatus: Component<{ job: JobDTO }> = (props) => {

  return (
    <Card>
      <CardHeader>
        <CardTitle>Processing: {jobLabel(props.job)}</CardTitle>
      </CardHeader>
      <CardContent>
        <Show
          when={props.job.status === "queued"}
          fallback={
            <div class="flex items-center gap-3 text-sm text-muted-foreground">
              <span
                class="size-5 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
                aria-hidden="true"
              />
              <span>Processing audio, this can take a few minutes...</span>
            </div>
          }
        >
          <div class="space-y-1">
            <p class="text-3xl font-semibold tabular-nums">
              #{props.job.position ?? "-"}
            </p>
            <p class="text-sm text-muted-foreground">Your position in the queue</p>
          </div>
        </Show>
      </CardContent>
    </Card>
  );
};

export default QueueStatus;
