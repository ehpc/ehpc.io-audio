import { createEffect, createSignal, onCleanup, type Component } from "solid-js";

const CopyLyricsButton: Component<{ text: string; trackLabel?: string }> = (props) => {
  const [state, setState] = createSignal<"idle" | "copied" | "error">("idle");
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let requestVersion = 0;
  let disposed = false;
  const clearFeedback = () => {
    clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
  };
  createEffect(() => {
    props.text;
    props.trackLabel;
    requestVersion++;
    clearFeedback();
    setState("idle");
  });
  onCleanup(() => {
    disposed = true;
    requestVersion++;
    clearFeedback();
  });

  const copy = async () => {
    const text = props.text;
    if (!text) return;
    const version = ++requestVersion;
    clearFeedback();
    setState("idle");
    try {
      await navigator.clipboard.writeText(text);
      if (disposed || version !== requestVersion) return;
      setState("copied");
      feedbackTimer = setTimeout(() => setState("idle"), 2000);
    } catch {
      if (disposed || version !== requestVersion) return;
      setState("error");
      feedbackTimer = setTimeout(() => setState("idle"), 3000);
    }
  };

  return (
    <span class="copy-lyrics-control">
      <button type="button" class="copy-lyrics-button" disabled={!props.text} aria-label={props.trackLabel ? `Copy ${props.trackLabel} lyrics` : "Copy lyrics"} onClick={copy}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" tabIndex={-1}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>
      </button>
      <span class="copy-lyrics-feedback" role={state() === "error" ? "alert" : "status"} aria-live="polite">
        {state() === "copied" ? "Lyrics copied" : state() === "error" ? "Could not copy lyrics" : ""}
      </span>
    </span>
  );
};

export default CopyLyricsButton;
