// Single source of truth for mixable stem components and mix naming.
// UI (MixBuilder), previews, serialization, and history display all derive
// from this catalog — no duplicated mix logic.
// Component ids are the canonical backend contract ids; the server maps them
// to separation model names.

export type StemComponent =
  | "drums"
  | "bass"
  | "vocals"
  | "other"
  | "instruments"
  | "female"
  | "male"
  | "lead"
  | "backing";

export type StemFamily = "main" | "vocal-variant";

export interface StemComponentDescriptor {
  id: StemComponent;
  label: string;
  family: StemFamily;
  /** Chip accent group matching the approved design colours. */
  accent: "drums" | "bass" | "vocal" | "other";
}

/** One queued mix: stable id (result label + download URL id), display name, parts. */
export interface StemMix {
  id: string;
  name: string;
  components: StemComponent[];
}

export const STEM_COMPONENTS: StemComponentDescriptor[] = [
  { id: "drums", label: "Drums", family: "main", accent: "drums" },
  { id: "bass", label: "Bass", family: "main", accent: "bass" },
  { id: "vocals", label: "Vocals", family: "main", accent: "vocal" },
  { id: "other", label: "Other instruments", family: "main", accent: "other" },
  { id: "instruments", label: "Instruments", family: "main", accent: "other" },
  { id: "female", label: "Female vocals", family: "vocal-variant", accent: "vocal" },
  { id: "male", label: "Male vocals", family: "vocal-variant", accent: "vocal" },
  { id: "lead", label: "Lead vocals", family: "vocal-variant", accent: "vocal" },
  { id: "backing", label: "Backing vocals", family: "vocal-variant", accent: "vocal" },
];

const BY_ID = new Map(STEM_COMPONENTS.map((component) => [component.id, component]));

export function stemComponent(id: StemComponent): StemComponentDescriptor {
  return BY_ID.get(id)!;
}

export function stemLabel(id: StemComponent): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Canonical component title join, used as the automatic mix name. */
export function stemMixName(components: StemComponent[]): string {
  return components.map(stemLabel).join(" + ");
}

/** A valid queued mix has 2+ unique components and a non-empty trimmed name. */
export function stemMixError(mix: StemMix): string | null {
  if (new Set(mix.components).size !== mix.components.length) {
    return "A mix cannot list the same part twice.";
  }
  if (mix.components.length < 2) {
    return "A mix needs at least 2 different parts.";
  }
  if (!mix.name.trim()) {
    return "A mix needs a name.";
  }
  if (mix.name.length > 120) {
    return "A mix name must be 120 characters or fewer.";
  }
  return null;
}

/** Contract id shape for queued mixes. */
const MIX_ID_PATTERN = /^mix-[a-z0-9][a-z0-9-]{0,47}$/;

export function mixIdValid(id: string): boolean {
  return MIX_ID_PATTERN.test(id);
}

/**
 * Next short monotonic id (mix-1, mix-2, ...). Derived from the highest
 * existing suffix and an optional already-issued floor, so removals never
 * free an id for reuse; edit/rename keeps the mix's original id.
 */
export function nextMixId(mixes: StemMix[], issued = 0): string {
  let highest = issued;
  for (const mix of mixes) {
    const match = /^mix-(\d+)$/.exec(mix.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `mix-${highest + 1}`;
}

/** Deterministic key for a component set, independent of order. */
export function stemMixKey(components: StemComponent[]): string {
  return [...components].sort().join("+");
}
