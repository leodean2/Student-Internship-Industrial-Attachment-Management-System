import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { INVALID_LINK_MESSAGE } from "../lib/messages";
import { lastRequest, mockFetch, openLink, renderPage } from "../test/helpers";
import { ResetPasswordPage } from "./ResetPasswordPage";

const TOKEN = "tok_reset_456";
const PASSWORD = "Correct-Horse-9!";

async function fill(password = PASSWORD, confirmation = PASSWORD) {
  await userEvent.type(screen.getByLabelText("New password"), password);
  await userEvent.type(screen.getByLabelText("Confirm new password"), confirmation);
  await userEvent.click(screen.getByRole("button", { name: "Change password" }));
}

describe("ResetPasswordPage", () => {
  it("sends the token and new password in the body and clears the token on success", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchMock = mockFetch(204);
    openLink(`/reset-password?token=${TOKEN}`);
    expect(window.location.search).toBe("");
    renderPage(<ResetPasswordPage />);
    await fill();

    const request = lastRequest(fetchMock);
    expect(request.url).toBe("http://api.test/api/v1/auth/confirm-password-reset");
    expect(request.url).not.toContain(TOKEN);
    expect(request.url).not.toContain("Horse");
    expect(request.body).toEqual({ token: TOKEN, newPassword: PASSWORD });
    expect(await screen.findByRole("status")).toHaveTextContent(/password has been changed/i);
    expect(window.location.search).toBe("");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not send anything when the passwords differ", async () => {
    const fetchMock = mockFetch(204);
    openLink(`/reset-password?token=${TOKEN}`);
    renderPage(<ResetPasswordPage />);
    await fill(PASSWORD, "something-else-entirely");
    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 410])("shows the same message for a refused link (%i)", async (status) => {
    mockFetch(status);
    openLink(`/reset-password?token=${TOKEN}`);
    renderPage(<ResetPasswordPage />);
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("keeps the form after the API rejects a password as invalid (400)", async () => {
    const fetchMock = mockFetch(400);
    openLink(`/reset-password?token=${TOKEN}`);
    renderPage(<ResetPasswordPage />);
    await fill("short", "short");
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not meet the requirements/i);
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a refused-link message and sends nothing when there is no token", () => {
    const fetchMock = mockFetch(204);
    renderPage(<ResetPasswordPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only one request when submitted repeatedly", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    openLink(`/reset-password?token=${TOKEN}`);
    renderPage(<ResetPasswordPage />);
    await userEvent.type(screen.getByLabelText("New password"), PASSWORD);
    await userEvent.type(screen.getByLabelText("Confirm new password"), PASSWORD);
    await userEvent.dblClick(screen.getByRole("button", { name: "Change password" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(null, { status: 204 }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});
