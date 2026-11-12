import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { captureStartupToken } from "../lib/startupToken";

export function openLink(pathWithQuery: string): void {
  window.history.replaceState(null, "", pathWithQuery);
  captureStartupToken();
}

export const renderPage = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

export function mockFetch(status: number, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(null, { status, headers });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function lastRequest(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("Expected fetch to have been called.");
  const [input, init] = call;
  return {
    url: String(input),
    init: init ?? {},
    body: JSON.parse(String(init?.body)),
  };
}
