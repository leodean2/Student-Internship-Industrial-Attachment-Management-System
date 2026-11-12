import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

const ACCESS_TOKEN = "private-access-token";

describe("App sign-in flow", () => {
  it("keeps the access token in memory and navigates to the home placeholder", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      accessToken: ACCESS_TOKEN,
      tokenType: "Bearer",
      expiresIn: 900,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/login");
    await userEvent.type(screen.getByLabelText("Email address"), "student@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "Correct-Horse-9!");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("status")).toHaveTextContent("You are signed in.");
    expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/home");
    expect(screen.queryByText(ACCESS_TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByText("student@example.test")).not.toBeInTheDocument();
    expect(window.location.href).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(window.history.state ?? "")).not.toContain(ACCESS_TOKEN);
    expect(document.cookie).not.toContain(ACCESS_TOKEN);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redirects a direct home visit to sign in when there is no in-memory token", () => {
    renderApp("/home");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

function renderApp(path: string) {
  window.history.replaceState(null, "", path);
  return render(<BrowserRouter><App /></BrowserRouter>);
}
