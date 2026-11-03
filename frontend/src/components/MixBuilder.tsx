import { createSignal, For, Show, type Component } from "solid-js";
import type { StemComponent, StemMix } from "~/lib/stemMix";
import { nextMixId, stemComponent, stemMixError, stemMixName, STEM_COMPONENTS } from "~/lib/stemMix";
import { Button } from "~/components/button";

interface MixBuilderProps {
  mixes: StemMix[];
  onMixesChange: (mixes: StemMix[]) => void;
  mobile: boolean;
}

/**
 * Arbitrary named mixes built from any 2+ unique stem components.
 * Owns only the draft being composed; the saved list is controlled by the
 * parent so it participates in form retention. Editing tracks the mix object
 * itself, so removing a different row can never retarget the edit, and
 * removing the row being edited discards the draft instead of saving into a
 * wrong mix. Saved mixes keep their id across rename/edit; new mixes get the
 * next monotonic id, never reusing removed ids.
 */
const MixBuilder: Component<MixBuilderProps> = (props) => {
  const [draft, setDraft] = createSignal<StemComponent[]>([]);
  const [editing, setEditing] = createSignal<StemMix | null>(null);
  const [customName, setCustomName] = createSignal(false);
  const [name, setName] = createSignal("");
  const [draftError, setDraftError] = createSignal<string | null>(null);
  // Highest mix id issued this session; keeps ids monotonic even after removals.
  let issuedMixId = 0;
  let nameInput: HTMLInputElement | undefined;
  let variantsDetails: HTMLDetailsElement | undefined;

  const autoName = () => stemMixName(draft());
  const isVariant = (id: StemComponent) => stemComponent(id).family === "vocal-variant";

  const togglePart = (id: StemComponent) => {
    setDraftError(null);
    const next = draft().includes(id) ? draft().filter((part) => part !== id) : [...draft(), id];
    setDraft(next);
    // Uncontrolled name field: the auto name is written imperatively so no
    // render effect can ever revert user typing mid-entry.
    if (!customName() && nameInput) nameInput.value = stemMixName(next);
  };

  const clearDraft = () => {
    setDraft([]);
    setEditing(null);
    setCustomName(false);
    setName("");
    setDraftError(null);
    if (nameInput) nameInput.value = "";
  };

  const addOrSave = () => {
    if (draft().length < 2) return;
    const current = editing();
    const id = current ? current.id : nextMixId(props.mixes, issuedMixId);
    if (!current) issuedMixId = Number(id.slice(4));
    const mix: StemMix = {
      // Edit/rename keeps the mix's identity; only new mixes consume an id.
      id,
      name: customName() ? (name().trim() || autoName()) : autoName(),
      components: [...draft()],
    };
    const invalid = stemMixError(mix);
    if (invalid) {
      setDraftError(invalid);
      return;
    }
    if (current === null) {
      props.onMixesChange([...props.mixes, mix]);
    } else {
      const index = props.mixes.indexOf(current);
      // The row being edited may have been removed while the draft was open;
      // in that case the edit is discarded rather than saved into a wrong mix.
      if (index !== -1) {
        const next = [...props.mixes];
        next[index] = mix;
        props.onMixesChange(next);
      }
    }
    clearDraft();
  };

  const edit = (mix: StemMix) => {
    setDraft([...mix.components]);
    setEditing(mix);
    const auto = stemMixName(mix.components);
    setCustomName(mix.name !== auto);
    setName(mix.name);
    if (nameInput) nameInput.value = mix.name;
    setDraftError(null);
    if (mix.components.some(isVariant) && variantsDetails) variantsDetails.open = true;
  };

  const remove = (mix: StemMix) => {
    props.onMixesChange(props.mixes.filter((candidate) => candidate !== mix));
    if (editing() === mix) clearDraft();
  };

  const partCount = () => draft().length;
  const canSave = () => partCount() >= 2;

  return (
    <fieldset class="option-group mix-group">
      <legend>Mixes <span class="new-tag">Build your own</span></legend>
      <p class="group-help">Choose any 2 or more parts. Add as many mixes as you need.</p>
      <div class="stem-choices" role="group" aria-label="Mix parts">
        <For each={STEM_COMPONENTS.filter((component) => component.family === "main")}>{(component) => (
          <button type="button" class="stem-choice" data-family={component.accent}
            aria-pressed={draft().includes(component.id)}
            onClick={() => togglePart(component.id)}>
            {component.label}
          </button>
        )}</For>
      </div>
      <p class="component-note">Other instruments = no drums or bass.<br />Instruments = drums + bass + other instruments.</p>
      <details class="vocal-variants" ref={variantsDetails}>
        <summary>Vocal variants · female, male, lead, backing</summary>
        <div class="stem-choices" role="group" aria-label="Vocal variants">
          <For each={STEM_COMPONENTS.filter((component) => component.family === "vocal-variant")}>{(component) => (
            <button type="button" class="stem-choice" data-family={component.accent}
              aria-pressed={draft().includes(component.id)}
              onClick={() => togglePart(component.id)}>
              {component.label}
            </button>
          )}</For>
        </div>
        <p class="component-note">Vocals contains all vocal parts. Choose a variant instead of Vocals for a more specific mix.</p>
      </details>
      <label for="mix-name" class="mix-name-label">Mix name</label>
      <div class="mix-compose">
        <input id="mix-name" type="text" ref={nameInput}
          placeholder={draft().length ? autoName() : "Choose parts above"}
          aria-label={editing() === null ? "New mix name" : `Mix name for ${editing()!.name}`}
          // Direct (non-delegated) listener: synthetic and real input events
          // must both reach the signal, and the saved name reads the signal,
          // never a DOM value a re-render could overwrite.
          on:input={(event) => {
            setCustomName(true);
            setName(event.currentTarget.value);
            setDraftError(null);
          }} />
        <Button type="button" class="primary-button" disabled={!canSave()} onClick={addOrSave}>
          {editing() === null ? "Add mix" : "Save mix"}
        </Button>
      </div>
      <Show when={draftError()}>
        <p role="alert" class="text-sm text-destructive">{draftError()}</p>
      </Show>
      <div class="draft-foot">
        <span aria-live="polite">
          {partCount()
            ? `${partCount()} ${partCount() === 1 ? "part" : "parts"} selected${partCount() === 1 ? " · choose one more" : ""}`
            : "Choose at least 2 parts"}
        </span>
        <button type="button" onClick={clearDraft}>{editing() === null ? "Clear" : "Cancel"}</button>
      </div>
      <Show when={props.mixes.length > 0}>
        <div class="mix-list-head">
          <span>Your mixes ({props.mixes.length})</span>
          <span class="mix-list-note">1 file per mix</span>
        </div>
        <div class="mix-list">
          <For each={props.mixes}>{(mix) => (
            <div class="mix-item" data-testid="mix-item" data-mix-name={mix.name} data-mix-id={mix.id}>
              <span class="mix-item-title" title={stemMixName(mix.components)}>
                {mix.name}
                <Show when={props.mobile && mix.name !== stemMixName(mix.components)}>
                  <span class="mix-item-parts">{stemMixName(mix.components)}</span>
                </Show>
              </span>
              <button type="button" aria-label={`Edit ${mix.name}`} onClick={() => edit(mix)}>Edit</button>
              <button type="button" class="remove" aria-label={`Remove ${mix.name}`} onClick={() => remove(mix)}>×</button>
            </div>
          )}</For>
        </div>
      </Show>
    </fieldset>
  );
};

export default MixBuilder;
