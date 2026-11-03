import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, type Component } from "solid-js";
import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import MixBuilder from "./MixBuilder";
import type { StemMix } from "~/lib/stemMix";

const chip = (label: string) => screen.getByRole("button", { name: label });

function clickParts(...labels: string[]) {
  for (const label of labels) fireEvent.click(chip(label));
}

function mixRows(): HTMLElement[] {
  return screen.getAllByTestId("mix-item");
}

function rowIds(): string[] {
  return mixRows().map((row) => row.dataset.mixId!);
}

function rowTitles(): string[] {
  return mixRows().map((row) => row.dataset.mixName!);
}

/** Reactive stand-in for the SubmitForm-owned mix list. */
const Harness: Component<{ initial: StemMix[]; mobile?: boolean }> = (props) => {
  const [mixes, setMixes] = createSignal(props.initial);
  return <MixBuilder mixes={mixes()} onMixesChange={setMixes} mobile={props.mobile ?? false} />;
};

describe("MixBuilder", () => {
  it("starts empty: add disabled, draft status prompts for two parts", () => {
    render(() => <Harness initial={[]} />);
    expect(chip("Add mix")).toBeDisabled();
    expect(screen.getByText("Choose at least 2 parts")).toBeInTheDocument();
    expect(screen.queryByText(/Your mixes/)).not.toBeInTheDocument();
  });

  it("requires 2+ parts and auto-names the draft, including 3+ stem mixes", () => {
    render(() => <Harness initial={[]} />);
    expect(chip("Add mix")).toBeDisabled();
    clickParts("Drums");
    expect(chip("Add mix")).toBeDisabled();
    expect(screen.getByText("1 part selected · choose one more")).toBeInTheDocument();
    clickParts("Bass");
    expect(chip("Add mix")).toBeEnabled();
    expect(screen.getByText("2 parts selected")).toBeInTheDocument();
    const name = screen.getByLabelText("New mix name") as HTMLInputElement;
    expect(name.value).toBe("Drums + Bass");
    fireEvent.click(chip("Vocals"));
    expect(name.value).toBe("Drums + Bass + Vocals");
    fireEvent.click(chip("Add mix"));
    expect(rowTitles()).toEqual(["Drums + Bass + Vocals"]);
    expect(rowIds()).toEqual(["mix-1"]);
  });

  it("queues multiple mixes with monotonic ids: the four approved pairs plus a vocal-variant mix", () => {
    render(() => <Harness initial={[]} />);
    const add = (parts: string[]) => {
      clickParts(...parts);
      fireEvent.click(chip("Add mix"));
    };
    add(["Drums", "Bass"]);
    add(["Drums", "Vocals"]);
    add(["Bass", "Vocals"]);
    add(["Drums", "Other instruments"]);
    fireEvent.click(screen.getByText(/Vocal variants/));
    add(["Female vocals", "Instruments"]);
    expect(screen.getByText("Your mixes (5)")).toBeInTheDocument();
    expect(rowTitles()).toEqual([
      "Drums + Bass",
      "Drums + Vocals",
      "Bass + Vocals",
      "Drums + Other instruments",
      "Female vocals + Instruments",
    ]);
    expect(rowIds()).toEqual(["mix-1", "mix-2", "mix-3", "mix-4", "mix-5"]);
  });

  it("editing a custom-named mix keeps the name and the component identity", () => {
    render(() => <Harness initial={[{ id: "mix-2", name: "My groove", components: ["drums", "bass"] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit My groove" }));
    expect(screen.getByLabelText("Mix name for My groove")).toHaveValue("My groove");
    fireEvent.click(chip("Vocals"));
    fireEvent.click(chip("Save mix"));
    // Custom name retained and id untouched; the underlying parts gain vocals (shown via tooltip).
    expect(screen.getByTitle("Drums + Bass + Vocals")).toBeInTheDocument();
    expect(rowTitles()).toEqual(["My groove"]);
    expect(rowIds()).toEqual(["mix-2"]);
  });

  it("cancel preserves the saved mix and clears the draft", () => {
    render(() => <Harness initial={[{ id: "mix-1", name: "Drums + Bass", components: ["drums", "bass"] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Drums + Bass" }));
    fireEvent.click(chip("Vocals"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(rowTitles()).toEqual(["Drums + Bass"]);
    expect(chip("Add mix")).toBeDisabled();
    expect(screen.getByText("Choose at least 2 parts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Drums + Bass" })).toBeInTheDocument();
  });

  it("removing an earlier row never retargets an open edit", () => {
    render(() => <Harness initial={[
      { id: "mix-1", name: "First", components: ["drums", "bass"] },
      { id: "mix-2", name: "Second", components: ["drums", "vocals"] },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Second" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove First" }));
    expect(screen.getByLabelText("Mix name for Second")).toHaveValue("Second");
    fireEvent.click(chip("Bass"));
    fireEvent.click(chip("Save mix"));
    expect(rowTitles()).toEqual(["Second"]);
    expect(rowIds()).toEqual(["mix-2"]);
    expect(screen.getByTitle("Drums + Vocals + Bass")).toBeInTheDocument();
  });

  it("discards the draft when the row being edited is removed, instead of saving into a wrong mix", () => {
    render(() => <Harness initial={[{ id: "mix-1", name: "Only", components: ["drums", "bass"] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Only" }));
    fireEvent.click(chip("Vocals"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Only" }));
    // Removing the edited row discards the draft: nothing can be saved afterward.
    expect(chip("Add mix")).toBeDisabled();
    expect(screen.getByText("Choose at least 2 parts")).toBeInTheDocument();
    expect(screen.queryByTestId("mix-item")).not.toBeInTheDocument();
  });

  it("never reuses a removed mix id for a new mix", () => {
    render(() => <Harness initial={[{ id: "mix-1", name: "Drums + Bass", components: ["drums", "bass"] }]} />);
    clickParts("Drums", "Vocals");
    fireEvent.click(chip("Add mix"));
    expect(rowIds()).toEqual(["mix-1", "mix-2"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Drums + Vocals" }));
    clickParts("Bass", "Vocals");
    fireEvent.click(chip("Add mix"));
    expect(rowIds()).toEqual(["mix-1", "mix-3"]);
  });

  it("allows duplicate custom names", async () => {
    render(() => <Harness initial={[{ id: "mix-1", name: "Same", components: ["drums", "bass"] }]} />);
    clickParts("Drums", "Vocals");
    const input = screen.getByLabelText("New mix name");
    // jsdom selection events are unreliable; clear the auto name by real
    // backspaces, then type the custom name.
    await userEvent.type(input, "{Backspace>14/}Same");
    fireEvent.click(chip("Add mix"));
    expect(rowTitles()).toEqual(["Same", "Same"]);
  });

  it("the un-added draft is not counted as a mix", () => {
    render(() => <Harness initial={[]} />);
    clickParts("Drums", "Bass", "Vocals");
    expect(screen.queryByText(/Your mixes/)).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("mix-item")).toHaveLength(0);
  });

  it("opening a variant mix's edit expands the collapsed vocal variants", () => {
    render(() => <Harness initial={[{ id: "mix-1", name: "Female vocals + Instruments", components: ["female", "instruments"] }]} />);
    const details = () => screen.getByText("Vocal variants · female, male, lead, backing").closest("details")!;
    expect(details()).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Edit Female vocals + Instruments" }));
    expect(details()).toHaveAttribute("open");
  });

  it("shows the component breakdown inline on mobile when a mix has a custom name", () => {
    render(() => <Harness initial={[{ id: "mix-1", name: "Chorus lift", components: ["drums", "bass"] }]} mobile={true} />);
    expect(screen.getByText("Drums + Bass")).toBeInTheDocument();
  });

  it("keeps the breakdown tooltip-only on desktop for custom names", () => {
    render(() => <Harness initial={[{ id: "mix-1", name: "Chorus lift", components: ["drums", "bass"] }]} mobile={false} />);
    expect(screen.queryByText("Drums + Bass")).not.toBeInTheDocument();
    expect(screen.getByTitle("Drums + Bass")).toBeInTheDocument();
  });
});
