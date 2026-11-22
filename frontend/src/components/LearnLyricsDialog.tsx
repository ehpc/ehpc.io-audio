import { createEffect, createSignal, Show, type Component } from "solid-js";
import * as Dialog from "@kobalte/core/dialog";
import type { JobDTO } from "~/api";
import { Button } from "~/components/button";
import LearnLyrics from "~/components/LearnLyrics";

const LearnLyricsDialog: Component<{ job: JobDTO }> = (props) => {
  const [open, setOpen] = createSignal(false);
  let currentJob = props.job.id;
  createEffect(() => {
    if (currentJob !== props.job.id) {
      currentJob = props.job.id;
      setOpen(false);
    }
  });

  return <Show when={(props.job.transcript?.presentation_lines?.length ?? 0) > 0}>
    <Dialog.Root open={open()} onOpenChange={setOpen}>
      <Dialog.Trigger as={Button} type="button" variant="outline" class="min-h-11">Learn lyrics</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay class="learn-overlay" />
        <Dialog.Content class="learn-dialog" aria-label="Learn lyrics">
          <header class="learn-header">
            <Dialog.Title>Learn lyrics</Dialog.Title>
            <Dialog.CloseButton as={Button} type="button" variant="outline" class="min-h-11" aria-label="Close learning">Close learning</Dialog.CloseButton>
          </header>
          <Dialog.Description class="learn-note">Listen, practise one section, and choose how much of each line to reveal.</Dialog.Description>
          <Show when={open()}><LearnLyrics job={props.job} /></Show>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </Show>;
};

export default LearnLyricsDialog;
