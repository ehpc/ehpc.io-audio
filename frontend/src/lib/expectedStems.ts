import type { SeparationOptions } from "~/api";
/** User-facing label for an output; API labels remain unchanged. */
export function displayOutputLabel(label: string, options: SeparationOptions): string {
  if (label === "original") return "Original (unchanged)";
  const base = label === "song" ? "Full song" : label;
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

// Mirrors SeparationOptions.result_labels: full source first when pitched,
// then explicit stems with each wet vocal immediately followed by its dry variant.
export function expectedStems(options: SeparationOptions): string[] {
  const labels: string[] = [];
  const selections = options.extract_vocals || options.extract_instruments ||
    options.mix_female_instruments || options.mix_male_instruments ||
    options.mix_backing_instruments || options.mix_lead_instruments || options.decrowd || options.decrowd_vocals ||
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
  if (options.mix_female_instruments) labels.push("female-instruments");
  if (options.mix_male_instruments) labels.push("male-instruments");
  if (options.mix_backing_instruments) labels.push("backing-instruments");
  if (options.mix_lead_instruments) labels.push("lead-instruments");
  if (dry && !selections) labels.push("vocals-dry");
  if (options.pitch_semitones !== 0 || (labels.length === 0 && options.tempo_percent !== 100)) labels.unshift("song");
  return labels;
}
