import { type Component } from "solid-js";
import type { JobDTO } from "~/api";
import KeyNotes from "~/components/KeyNotes";

const AudioMetadata: Component<{ job: JobDTO }> = (props) => (
  <dl class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <div>
      <dt class="inline">Original key: </dt>
      <dd class="inline">{props.job.original_key ?? (props.job.status === "done" ? "Undetermined" : props.job.status === "failed" ? "Unavailable" : "Pending")}<KeyNotes musicalKey={props.job.original_key} /></dd>
    </div>
    <div>
      <dt class="inline">Output key: </dt>
      <dd class="inline">{props.job.output_key ?? (props.job.status === "done" ? "Undetermined" : props.job.status === "failed" ? "Unavailable" : "Pending")}<KeyNotes musicalKey={props.job.output_key} /></dd>
    </div>
    <div>
      <dt class="inline">Pitch shift: </dt>
      <dd class="inline">{props.job.options.pitch_semitones > 0 ? "+" : ""}{props.job.options.pitch_semitones} semitones</dd>
    </div>
    <div>
      <dt class="inline">Tempo: </dt>
      <dd class="inline">{props.job.options.tempo_percent}% of original</dd>
    </div>
  </dl>
);

export default AudioMetadata;
