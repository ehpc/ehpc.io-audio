import { onCleanup, onMount, Show, type Component } from "solid-js";
import { jobLabel, type JobDTO } from "~/api";
import JobSteps, { phaseLabels } from "./JobSteps";

const JobStatusDock: Component<{ job: JobDTO; onView: () => void }> = (props) => {
  let dock: HTMLDivElement | undefined;
  onMount(() => {
    const root = document.documentElement;
    const update = () => root.style.setProperty("--job-dock-height", `${dock?.getBoundingClientRect().height ?? 0}px`);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (dock) observer?.observe(dock);
    window.addEventListener("resize", update);
    update();
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      root.style.removeProperty("--job-dock-height");
    });
  });
  const active = () => props.job.status === "queued" || props.job.status === "running";
  return (
    <div ref={dock} class="job-dock" role="status" aria-live="polite">
      <Show when={active()} fallback={<span class="job-dock-mark" aria-hidden="true">{props.job.status === "done" ? "✓" : "!"}</span>}>
        <span class="job-dock-spinner" aria-hidden="true" />
      </Show>
      <div class="job-dock-copy">
        <strong title={jobLabel(props.job)}>{jobLabel(props.job)}</strong>
        <span>{props.job.status === "queued" ? "Queued · Waiting to start" : props.job.status === "running" ? (props.job.progress.current ? phaseLabels[props.job.progress.current] : "Processing audio") : props.job.status === "done" ? "Complete" : "Failed"}</span>
        <Show when={props.job.status !== "failed"} fallback={<div class="job-steps-placeholder" aria-hidden="true" />}><JobSteps job={props.job} compact /></Show>
      </div>
      <button type="button" onClick={props.onView}>{active() ? "View progress" : props.job.status === "done" ? "View result" : "View error"}</button>
    </div>
  );
};

export default JobStatusDock;
