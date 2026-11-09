import type { StemManifestEntry, SeparationOptions } from "~/api";

/**
 * User-facing output labels apply transform suffixes; manifest names replace
 * only the base label so the suffix remains consistent with the selected options.
 */
function outputBaseLabel(label: string, options: SeparationOptions): string {
  if (label === "original") return "Original (unchanged)";
  if (label === "drums-vocals") return "Drums + Vocals";
  const mix = options.mixes?.find((candidate) => candidate.id === label);
  return mix ? mix.name : label === "song" ? "Full song" : label;
}

function appendAdjustments(base: string, options: SeparationOptions): string {
  const adjustments: string[] = [];
  if (options.pitch_semitones !== 0) {
    const pitch = String(options.pitch_semitones);
    adjustments.push(`pitch ${options.pitch_semitones > 0 ? "+" : ""}${pitch} st`);
  }
  if (options.tempo_percent !== 100) {
    adjustments.push(`tempo ${options.tempo_percent}%`);
  }
  return adjustments.length ? `${base} (${adjustments.join(", ")})` : base;
}

export function displayOutputLabel(label: string, options: SeparationOptions): string {
  const base = outputBaseLabel(label, options);
  return label === "original" ? base : appendAdjustments(base, options);
}

/** Server names replace the base label; client-side transform suffixes still apply. */
export function manifestOutputLabel(stem: StemManifestEntry, options: SeparationOptions): string {
  if (stem.label === "original") return "Original (unchanged)";
  const base = stem.label === "song"
    ? "Full song"
    : stem.display_name ?? outputBaseLabel(stem.label, options);
  return appendAdjustments(base, options);
}

// Mirrors SeparationOptions result labels: full source first when pitched,
// then explicit stems with each wet vocal immediately followed by its dry
// variant, then one result per queued mix (result label = mix id).
export function expectedStems(options: SeparationOptions): string[] {
  const labels: string[] = [];
  const selections = options.extract_vocals || options.extract_instruments ||
    options.mixes.length > 0 || options.decrowd || options.decrowd_vocals ||
    options.genders || options.lead_backing || options.drums;
  const dry = options.dereverb;
  const vocal = (label: string) => {
    labels.push(label);
    if (dry) labels.push(`${label}-dry`);
  };
  if (options.extract_vocals) vocal("vocals");
  if (options.decrowd_vocals) vocal("vocals-decrowded");
  if (options.genders) {
    vocal("vocals-male");
    vocal("vocals-female");
  }
  if (options.lead_backing) {
    vocal("lead");
    vocal("backing");
  }
  if (options.extract_instruments) labels.push("instruments");
  if (options.decrowd) labels.push("instruments-decrowded");
  if (options.drums) labels.push("drums", "bass", "other-instruments");
  if (options.detect_pitch) labels.push("drums-vocals");
  for (const mix of options.mixes) labels.push(mix.id);
  if (dry && !selections && !options.detect_pitch) labels.push("vocals-dry");
  if (options.pitch_semitones !== 0 || (labels.length === 0 && options.tempo_percent !== 100)) labels.unshift("song");
  return labels;
}

/** Mirrors the backend's analysis targets without exporting prerequisite audio. */
export function expectedPitchStems(options: SeparationOptions): string[] {
  if (!options.detect_pitch && !options.extract_pitched_lyrics) return [];
  const vocalLabels: Record<string, true> = { vocals: true, "vocals-decrowded": true, "vocals-male": true, "vocals-female": true, lead: true, backing: true };
  const selected = expectedStems(options).filter(label => vocalLabels[label.replace(/-dry$/, "")]);
  return selected.length ? selected : ["vocals"];
}
