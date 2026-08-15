import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "~/api";
import SubmitForm from "./SubmitForm";

vi.mock("~/api", () => ({ submitJob: vi.fn() }));

const submitButton = () => screen.getByRole("button", { name: /start separation/i });

describe("SubmitForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks submit and shows an error when neither URL nor file is given", async () => {
    const onSubmitted = vi.fn();
    render(() => <SubmitForm onSubmitted={onSubmitted} />);

    await userEvent.click(submitButton());

    expect(screen.getByText(/provide a url or choose a file/i)).toBeInTheDocument();
    expect(api.submitJob).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("submits a URL and hands the new job to the parent", async () => {
    vi.mocked(api.submitJob).mockResolvedValue({
      id: 7,
      status: "queued",
      position: 1,
    });
    const onSubmitted = vi.fn();
    render(() => <SubmitForm onSubmitted={onSubmitted} />);

    await userEvent.type(
      screen.getByPlaceholderText("https://..."),
      "https://example.com/x",
    );
    await userEvent.click(submitButton());

    await waitFor(() => expect(api.submitJob).toHaveBeenCalledOnce());
    expect(onSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, status: "queued", source_type: "url" }),
    );
  });
});
