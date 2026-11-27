import { createSignal } from "solid-js";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CopyLyricsButton from "./CopyLyricsButton";

let originalClipboard: PropertyDescriptor | undefined;
const setClipboard = (writeText: (text: string) => Promise<void>) => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
};
afterEach(() => {
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  originalClipboard = undefined;
});

describe("CopyLyricsButton", () => {
  it("announces success only after the clipboard write completes", async () => {
    const pending = Promise.withResolvers<void>();
    const writeText = vi.fn().mockReturnValue(pending.promise);
    setClipboard(writeText);
    render(() => <CopyLyricsButton text="timestamped lyrics with spacing" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy lyrics" }));
    expect(screen.queryByText("Lyrics copied")).not.toBeInTheDocument();
    pending.resolve();
    expect(await screen.findByText("Lyrics copied")).toBeInTheDocument();
  });

  it("reports denied clipboard access as an error without success feedback", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard(writeText);
    render(() => <CopyLyricsButton text="lyrics" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy lyrics" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy lyrics");
    expect(screen.queryByText("Lyrics copied")).not.toBeInTheDocument();
  });
  it("disables empty lyrics and ignores an old copy after the selected text changes", async () => {
    const pending = Promise.withResolvers<void>();
    const writeText = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    setClipboard(writeText);
    const [text, setText] = createSignal("");
    render(() => <CopyLyricsButton text={text()} trackLabel="Vocals" />);
    const button = screen.getByRole("button", { name: "Copy Vocals lyrics" });
    expect(button).toBeDisabled();
    setText("first track");
    await userEvent.click(button);
    setText("second track");
    pending.resolve();
    await Promise.resolve();
    expect(screen.queryByText("Lyrics copied")).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByText("Lyrics copied")).toBeInTheDocument();
  });
});
