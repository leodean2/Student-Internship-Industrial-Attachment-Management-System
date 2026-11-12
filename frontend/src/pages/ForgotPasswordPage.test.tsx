import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { lastRequest, mockFetch, renderPage } from "../test/helpers";
import { ForgotPasswordPage } from "./ForgotPasswordPage";

describe("ForgotPasswordPage", () => {
  it("posts the address in the body and shows a neutral response", async () => {
    const fetchMock = mockFetch(202);
    renderPage(<ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText("Email address"), "student@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    const request = lastRequest(fetchMock);
    expect(request.url).toBe("http://api.test/api/v1/auth/request-password-reset");
    expect(request.url).not.toContain("student");
    expect(request.body).toEqual({ email: "student@example.test" });
    expect(request.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store" });
    expect(window.location.search).toBe("");
    expect(await screen.findByRole("status")).toHaveTextContent(/if an account exists/i);
  });

  it("does not reveal whether the account exists", async () => {
    mockFetch(202);
    renderPage(<ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText("Email address"), "unknown@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    const text = (await screen.findByRole("status")).textContent ?? "";
    expect(text).toMatch(/if an account exists/i);
    expect(text).not.toMatch(/not found|no account|does not exist/i);
  });

  it("reports rate limiting", async () => {
    mockFetch(429, { "Retry-After": "3600" });
    renderPage(<ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText("Email address"), "a@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/60 minutes/);
  });

  it("sends nothing for an empty address", async () => {
    const fetchMock = mockFetch(202);
    renderPage(<ForgotPasswordPage />);
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
