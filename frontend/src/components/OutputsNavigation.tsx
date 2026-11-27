import { createEffect, createSignal, For, onCleanup, onMount, type Component } from "solid-js";
import OutputIcon from "~/components/OutputIcon";

export type OutputTarget = {
  kind: "karaoke" | "pitched-lyrics" | "lyrics" | "audio";
  id: string;
};

const labels: Record<OutputTarget["kind"], string> = {
  karaoke: "Karaoke",
  "pitched-lyrics": "Pitched lyrics",
  lyrics: "Lyrics",
  audio: "Audio",
};

const OutputsNavigation: Component<{ targets: OutputTarget[]; visible: boolean }> = (props) => {
  let navigation: HTMLElement | undefined;
  const [measuredHeight, setMeasuredHeight] = createSignal(0);
  createEffect(() => {
    const measured = measuredHeight();
    const height = navigation?.getBoundingClientRect().height || measured;
    document.documentElement.style.setProperty("--outputs-navigation-height", `${props.visible && props.targets.length ? height : 0}px`);
  });
  onMount(() => {
    const update = () => setMeasuredHeight(navigation?.getBoundingClientRect().height ?? 0);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (navigation) observer?.observe(navigation);
    window.addEventListener("resize", update);
    update();
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      document.documentElement.style.removeProperty("--outputs-navigation-height");
    });
  });

  return (
    <nav ref={navigation} class="outputs-navigation" aria-label="Song outputs" hidden={!props.visible || props.targets.length === 0}>
      <For each={props.targets}>{(target) => (
        <a href={`#${target.id}`} aria-label={`Go to ${labels[target.kind]}`} onClick={(event) => {
          event.preventDefault();
          const destination = document.getElementById(target.id);
          if (!destination) return;
          const focusTarget = target.kind === "karaoke" ? document.getElementById("karaoke") ?? destination : destination;
          destination.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
          if (!focusTarget.hasAttribute("tabindex")) focusTarget.setAttribute("tabindex", "-1");
          focusTarget.focus({ preventScroll: true });
        }}>
          <OutputIcon kind={target.kind === "audio" ? "audio" : target.kind} label={labels[target.kind]} />
          <span>{labels[target.kind]}</span>
        </a>
      )}</For>
    </nav>
  );
};

export default OutputsNavigation;
