import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { lastRequest, mockFetch, renderPage } from "../test/helpers";
import { LoginPage } from "./LoginPage";

const EMAIL = "student@example.test";
const PASSWORD = "Correct-Horse-9!";

describe("LoginPage", () => {
  it("shows the approved registration note for everyone", () => {
    renderPage(<LoginPage onLogin={vi.fn()} />);
    expect(screen.getByText("New students can sign in once their department has confirmed their registration."))
      .toBeInTheDocument();
  });

  it("uses password-manager autocomplete for the username and password fields", () => {
    renderPage(<LoginPage onLogin={vi.fn()} />);
    expect(screen.getByLabelText("Email address")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
  });

  it.each([400, 401, 403, 429, 500])("uses the same generic message for every API failure (%i)", async (status) => {
    const fetchMock = mockFetch(status);
    renderPage(<LoginPage onLogin={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Email address"), EMAIL);
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't sign you in. Check your details and try again.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends login details in the body and includes cookies", async () => {
    const fetchMock = mockFetch(401);
    renderPage(<LoginPage onLogin={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Email address"), EMAIL);
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const request = lastRequest(fetchMock);
    expect(request.url).toBe("http://api.test/api/v1/auth/login");
    expect(request.url).not.toContain(EMAIL);
    expect(request.body).toEqual({ email: EMAIL, password: PASSWORD });
    expect(request.init).toMatchObject({ method: "POST", credentials: "include", cache: "no-store" });
  });

  it("does not send a request until explicitly submitted", () => {
    const fetchMock = mockFetch(401);
    renderPage(<LoginPage onLogin={vi.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send multiple requests when submitted repeatedly", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const onLogin = vi.fn();
    renderPage(<LoginPage onLogin={onLogin} />);
    await userEvent.type(screen.getByLabelText("Email address"), EMAIL);
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.dblClick(screen.getByRole("button", { name: "Sign in" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ accessToken: "access-test", tokenType: "Bearer", expiresIn: 900 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    expect(await screen.findByText("New students can sign in once their department has confirmed their registration."))
      .toBeInTheDocument();
    expect(onLogin).toHaveBeenCalledWith("access-test");
  });

  it("rejects a successful response without a valid access token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accessToken: "" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderPage(<LoginPage onLogin={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Email address"), EMAIL);
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't sign you in/i);
  });
});
