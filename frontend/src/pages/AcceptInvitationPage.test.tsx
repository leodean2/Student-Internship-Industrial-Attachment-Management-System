import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { INVALID_LINK_MESSAGE } from "../lib/messages";
import { clearStartupToken } from "../lib/startupToken";
import { lastRequest, mockFetch, openLink, renderPage } from "../test/helpers";
import { AcceptInvitationPage } from "./AcceptInvitationPage";

const TOKEN = "tok_invitation_123";
const PASSWORD = "Correct-Horse-9!";

describe("AcceptInvitationPage", () => {
  it("strips the token from the URL and sends nothing until explicit submission", () => {
    const fetchMock = mockFetch(201);
    openLink(`/accept-invitation?token=${TOKEN}`);
    renderPage(<AcceptInvitationPage />);

    expect(window.location.search).toBe("");
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the token only in the POST body and does not write storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchMock = mockFetch(201);
    openLink(`/accept-invitation?token=${TOKEN}`);
    renderPage(<AcceptInvitationPage />);

    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "  Test Student  " } });
    fireEvent.change(screen.getByLabelText("Create a password"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Staff ID (optional)"), { target: { value: "ST-204" } });
    fireEvent.change(screen.getByLabelText("Job title (optional)"), { target: { value: "Coordinator" } });
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    const request = lastRequest(fetchMock);
    expect(request.url).toBe("http://api.test/api/v1/invitations/accept");
    expect(request.url).not.toContain(TOKEN);
    expect(request.body).toEqual({
      token: TOKEN,
      password: PASSWORD,
      name: "Test Student",
      staffId: "ST-204",
      title: "Coordinator",
    });
    expect(request.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store" });
    expect(await screen.findByRole("status")).toHaveTextContent(/account is ready/i);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("uses password-manager autocomplete for both password fields", () => {
    openLink(`/accept-invitation?token=${TOKEN}`);
    renderPage(<AcceptInvitationPage />);
    expect(screen.getByLabelText("Create a password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute("autocomplete", "new-password");
  });

  it("does not submit when the password confirmation does not match", async () => {
    const fetchMock = mockFetch(201);
    openLink(`/accept-invitation?token=${TOKEN}`);
    renderPage(<AcceptInvitationPage />);

    await userEvent.type(screen.getByLabelText("Full name"), "Test Student");
    await userEvent.type(screen.getByLabelText("Create a password"), PASSWORD);
    await userEvent.type(screen.getByLabelText("Confirm password"), "another-valid-password");
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/passwords do not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not submit an invalid password", async () => {
    const fetchMock = mockFetch(201);
    openLink(`/accept-invitation?token=${TOKEN}`);
    renderPage(<AcceptInvitationPage />);

    await userEvent.type(screen.getByLabelText("Full name"), "Test Student");
    await userEvent.type(screen.getByLabelText("Create a password"), "too-short");
    await userEvent.type(screen.getByLabelText("Confirm password"), "too-short");
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/password must meet the requirements/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 410])("shows the same message for a refused invitation (%i)", async (status) => {
    mockFetch(status);
    openLink(`/accept-invitation?token=${TOKEN}`);
    renderPage(<AcceptInvitationPage />);

    await userEvent.type(screen.getByLabelText("Full name"), "Test Student");
    await userEvent.type(screen.getByLabelText("Create a password"), PASSWORD);
    await userEvent.type(screen.getByLabelText("Confirm password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
  });

  it("shows a refused-link message and sends nothing when there is no token", () => {
    clearStartupToken();
    const fetchMock = mockFetch(201);
    renderPage(<AcceptInvitationPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only one request when submitted repeatedly", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    openLink(`/accept-invitation?token=${TOKEN}`);
    renderPage(<AcceptInvitationPage />);
    await userEvent.type(screen.getByLabelText("Full name"), "Test Student");
    await userEvent.type(screen.getByLabelText("Create a password"), PASSWORD);
    await userEvent.type(screen.getByLabelText("Confirm password"), PASSWORD);
    await userEvent.dblClick(screen.getByRole("button", { name: "Accept invitation" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(null, { status: 201 }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});
