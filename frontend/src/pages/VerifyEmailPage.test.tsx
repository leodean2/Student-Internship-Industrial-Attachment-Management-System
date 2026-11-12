import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { INVALID_LINK_MESSAGE } from "../lib/messages";
import { lastRequest, mockFetch, openLink, renderPage } from "../test/helpers";
import { VerifyEmailPage } from "./VerifyEmailPage";

const TOKEN = "tok_verify_123";

describe("VerifyEmailPage", () => {
  it("sends nothing on load and requires a click", () => {
    const fetchMock = mockFetch(200);
    openLink(`/verify-email?token=${TOKEN}`);
    renderPage(<VerifyEmailPage />);
    expect(screen.getByRole("button", { name: "Confirm my email" })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the token out of the address bar, request URL and storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchMock = mockFetch(200);
    openLink(`/verify-email?token=${TOKEN}`);
    expect(window.location.search).toBe("");
    renderPage(<VerifyEmailPage />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm my email" }));

    const request = lastRequest(fetchMock);
    expect(request.url).toBe("http://api.test/api/v1/auth/verify-email");
    expect(request.url).not.toContain(TOKEN);
    expect(request.body).toEqual({ token: TOKEN });
    expect(request.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store" });
    expect(window.location.search).toBe("");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("explains registration review after successful verification", async () => {
    mockFetch(200);
    openLink(`/verify-email?token=${TOKEN}`);
    renderPage(<VerifyEmailPage />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm my email" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/registration number now needs to be confirmed/i);
  });

  it.each([400, 401, 403, 404, 409, 410])("shows the same message for a refused link (%i)", async (status) => {
    mockFetch(status);
    openLink(`/verify-email?token=${TOKEN}`);
    renderPage(<VerifyEmailPage />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm my email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
  });

  it("shows a refused-link message and sends nothing when there is no token", () => {
    const fetchMock = mockFetch(200);
    renderPage(<VerifyEmailPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports rate limiting and permits a later attempt", async () => {
    mockFetch(429, { "Retry-After": "600" });
    openLink(`/verify-email?token=${TOKEN}`);
    renderPage(<VerifyEmailPage />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm my email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/10 minutes/);
    expect(screen.getByRole("button", { name: "Confirm my email" })).toBeEnabled();
  });

  it("allows another try after a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    openLink(`/verify-email?token=${TOKEN}`);
    renderPage(<VerifyEmailPage />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm my email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
    expect(screen.getByRole("button", { name: "Confirm my email" })).toBeEnabled();
  });

  it("sends only one request when clicked repeatedly", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    openLink(`/verify-email?token=${TOKEN}`);
    renderPage(<VerifyEmailPage />);
    await userEvent.dblClick(screen.getByRole("button", { name: "Confirm my email" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(null, { status: 200 }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});
