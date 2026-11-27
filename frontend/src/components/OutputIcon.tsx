import type { Component } from "solid-js";

export type OutputIconKind = "drums" | "bass" | "vocals" | "instrument" | "song" | "lyrics" | "pitched-lyrics" | "karaoke" | "mix" | "audio";
export type OutputIconProps =
  | { label: string; identity: string; kind?: never }
  | { label: string; kind: OutputIconKind; identity?: never };

const outputKind = (identity: string): OutputIconKind => {
  if (identity === "mix" || identity.startsWith("mix:")) return "mix";
  const canonical = identity.replace(/:decrowded$/, "");
  if (canonical === "karaoke") return "karaoke";
  if (canonical === "pitched-lyrics") return "pitched-lyrics";
  if (canonical === "lyrics") return "lyrics";
  if (canonical === "drums") return "drums";
  if (canonical === "bass") return "bass";
  if (["vocals", "vocals-decrowded", "vocals-male", "vocals-female", "lead", "backing"].includes(canonical)) return "vocals";
  if (["song", "full-song", "original"].includes(canonical)) return "song";
  if (["instrument", "instruments", "instruments-decrowded", "other-instruments", "guitar"].includes(canonical)) return "instrument";
  return "mix";
};

const paths: Record<OutputIconKind, string> = {
  drums: "M4 9a8 3 0 0 0 16 0a8 3 0 0 0-16 0 M4 9v8a8 3 0 0 0 16 0V9 M4 17a8 3 0 0 0 16 0 M6 4l5 4 M18 4l-5 4",
  bass: "M14 9l5-5 2 2-5 5 M13 10c-2-2-5-1-7 1s-3 5-1 7 5 1 7-1 3-5 1-7z M17 5l2-2 M16 7l2 2 M9 13l3 3 M8 16l1 1",
  vocals: "M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3 M6 11a6 6 0 0 0 12 0 M12 17v4 M9 21h6",
  instrument: "M14 9l5-5 2 2-5 5 M13 10c-2-2-5-1-7 1s-3 5-1 7 5 1 7-1 3-5 1-7z M17 5l2-2 M16 7l2 2 M9 13l3 3 M8 16l1 1 M11 14a1 1 0 1 0 0 2",
  song: "M9 18V5l12-2v13 M9 9l12-2 M6 18a3 3 0 1 0 3 3v-3 M18 16a3 3 0 1 0 3 3v-3",
  lyrics: "M5 5h14 M5 10h14 M5 15h9 M5 20h11",
  "pitched-lyrics": "M4 5h8 M4 10h8 M4 15h6 M16 13V4l5-1v9 M16 13a2 2 0 1 0 2 2v-2 M21 12a2 2 0 1 0 2 2v-2",
  karaoke: "M3 5h8 M3 10h8 M3 15h6 M14 15V5l7-1v10 M14 15a2 2 0 1 0 2 2v-2 M21 14a2 2 0 1 0 2 2v-2",
  mix: "M12 3 3 7l9 4 9-4-9-4z M3 12l9 4 9-4 M3 17l9 4 9-4",
  audio: "M3 12h3l3-8 5 16 3-8h4",
};

const OutputIcon: Component<OutputIconProps> = (props) => {
  const kind = () => props.kind ?? outputKind(props.identity ?? "");
  return <svg class="output-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" tabIndex={-1}><path d={paths[kind()]} /></svg>;
};

export default OutputIcon;
