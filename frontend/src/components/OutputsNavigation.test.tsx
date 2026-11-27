import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import OutputsNavigation from "./OutputsNavigation";

const targets = [{ kind: "lyrics" as const, id: "lyrics-output" }];

describe("OutputsNavigation", () => {
  it("scrolls to and focuses an available output without replacing its media", async () => {
    const { container } = render(() => <>
      <OutputsNavigation targets={targets} visible />
      <section id="lyrics-output" tabIndex={-1}><audio aria-label="Current song audio" /></section>
    </>);
    const destination = container.querySelector<HTMLElement>("#lyrics-output")!;
    const audio = container.querySelector("audio")!;
    destination.scrollIntoView = vi.fn();
    await userEvent.click(screen.getByRole("link", { name: "Go to Lyrics" }));
    expect(destination).toHaveFocus();
    expect(container.querySelector("audio")).toBe(audio);
  });
  it("focuses the inner karaoke keyboard target instead of its scroll wrapper", async () => {
    const { container } = render(() => <>
      <OutputsNavigation targets={[{ kind: "karaoke", id: "song-karaoke" }]} visible />
      <section id="song-karaoke"><div id="karaoke" tabIndex={0} /></section>
    </>);
    container.querySelector<HTMLElement>("#song-karaoke")!.scrollIntoView = vi.fn();
    await userEvent.click(screen.getByRole("link", { name: "Go to Karaoke" }));
    expect(container.querySelector("#karaoke")).toHaveFocus();
  });

  it("hides navigation when shortcuts or their destinations are unavailable", () => {
    const { container, unmount } = render(() => <OutputsNavigation targets={targets} visible={false} />);
    expect(container.querySelector("nav")).toHaveAttribute("hidden");
    unmount();
    const empty = render(() => <OutputsNavigation targets={[]} visible />);
    expect(empty.container.querySelector("nav")).toHaveAttribute("hidden");
  });
});
