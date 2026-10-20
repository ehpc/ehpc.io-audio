import { Show, type Component } from "solid-js";
import { keyScale } from "~/lib/music";

const KeyNotes: Component<{ musicalKey: string | null }> = (props) => (
  <Show when={keyScale(props.musicalKey)}>
    {(scale) => (
      <span class="block text-xs text-muted-foreground">
        Notes ({scale().mode}): {scale().notes.join(" · ")}
      </span>
    )}
  </Show>
);

export default KeyNotes;
