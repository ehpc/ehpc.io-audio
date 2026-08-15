import type { SeparationOptions } from "~/api";

// Mirrors the stem labels produced by separator/stems.py's run_separation —
// keep in sync if that logic changes. A split model emits both of its stems in
// one pass, so a group's wet stems come out together followed by their dry
// ("-dry") counterparts when dereverb is on.
export function expectedStems(options: SeparationOptions): string[] {
  const dry = options.dereverb;
  const labels: string[] = ["vocals"];
  if (dry) labels.push("vocals-dry");

  if (options.genders) {
    labels.push("vocals-male", "vocals-female");
    if (dry) labels.push("vocals-male-dry", "vocals-female-dry");
  }
  if (options.lead_backing) {
    labels.push("lead", "backing");
    if (dry) labels.push("lead-dry", "backing-dry");
  }

  labels.push("instruments");
  if (options.decrowd) labels.push("instruments-decrowded");
  if (options.drums) labels.push("drums", "bass", "other-instruments");

  return labels;
}
