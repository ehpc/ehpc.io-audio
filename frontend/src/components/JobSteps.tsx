import { For, type Component } from "solid-js";
import type { JobDTO, JobPhase } from "~/api";

export const phaseLabels: Record<JobPhase, string> = {
  source: "Preparing source",
  analysis: "Detecting song key",
  wait: "Waiting for processing",
  metadata: "Reading song metadata",
  separation: "Separating audio",
  lyrics: "Transcribing and aligning lyrics",
  pitch: "Detecting vocal pitch",
  export: "Preparing outputs",
};

const JobSteps: Component<{ job: JobDTO; compact?: boolean }> = (props) => {
  const currentIndex = () => props.job.progress.current === null ? -1 : props.job.progress.steps.indexOf(props.job.progress.current);
  return (
    <ol class={props.compact ? "job-steps job-steps-compact" : "job-steps"} aria-label="Processing steps">
      <For each={props.job.progress.steps}>{(phase, index) => {
        const state = () => props.job.status === "done" ? "Complete" : currentIndex() < 0 ? "Pending" : index() < currentIndex() ? "Complete" : index() === currentIndex() ? "Current" : "Pending";
        return <li class={`job-step job-step-${state().toLowerCase()}`} aria-current={state() === "Current" ? "step" : undefined}>
          <span class="job-step-indicator" aria-hidden="true" />
          <span class={props.compact ? "sr-only" : "job-step-label"}>{phaseLabels[phase]}: {state()}</span>
        </li>;
      }}</For>
    </ol>
  );
};

export default JobSteps;
