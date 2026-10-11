import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { renderWithClient, spyOnConsoleError, stubFetch } from "./test/harness.tsx";

const WORK = { name: "Praca", endpointOrigin: "https://router.corp.example" };

// What each address of the API does in a test: answers as the server would, or cannot be reached.
function stubApi(up: { health: boolean; workspace: boolean }) {
  return stubFetch(async (input) => {
    const path = String(input);
    if (path === "/api/health" && up.health) return Response.json({ status: "ok" });
    if (path === "/api/workspace" && up.workspace) return Response.json(WORK);
    throw new TypeError("fetch failed");
  });
}

function indicator() {
  return screen.getByRole("status", { name: "Aktywny workspace" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// App.test.tsx puts nothing in the indicator's place, to count the requests of the health check
// alone. So only here is the page rendered as it is: the indicator has to be on it, whatever the
// health check says, because it is what tells the owner which workspace the data goes to.
describe("App, with the workspace indicator in place", () => {
  it("shows the indicator from the first moment, before the server has answered anything", () => {
    stubApi({ health: true, workspace: true });

    renderWithClient(<App />);

    expect(screen.getByText("Sprawdzam połączenie…")).toBeInTheDocument();
    expect(indicator()).toHaveTextContent("Sprawdzam workspace…");
  });

  it("names the workspace in the card, under the line that says the server is up", async () => {
    const fetchMock = stubApi({ health: true, workspace: true });

    renderWithClient(<App />);

    const healthLine = await screen.findByText("Serwer działa");
    expect(await within(indicator()).findByText("Praca")).toBeInTheDocument();
    expect(indicator()).toHaveTextContent("https://router.corp.example");
    // In the same card as the heading and the health line, and after both.
    const card = screen.getByRole("heading", { level: 1 }).parentElement;
    expect(card).toContainElement(healthLine);
    expect(card).toContainElement(indicator());
    expect(healthLine.compareDocumentPosition(indicator()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).sort()).toEqual(["/api/health", "/api/workspace"]);
  });

  it("keeps the indicator on the page when the server cannot be reached", async () => {
    spyOnConsoleError();
    stubApi({ health: false, workspace: false });

    renderWithClient(<App />);

    expect(await screen.findByText("Brak połączenia z serwerem")).toBeInTheDocument();
    expect(await within(indicator()).findByText("Nie udało się odczytać workspace'u")).toBeInTheDocument();
  });

  it("goes on naming a workspace that was confirmed when only the health check fails", async () => {
    spyOnConsoleError();
    stubApi({ health: false, workspace: true });

    renderWithClient(<App />);

    expect(await screen.findByText("Brak połączenia z serwerem")).toBeInTheDocument();
    expect(await within(indicator()).findByText("Praca")).toBeInTheDocument();
  });

  it("keeps saying that the server is up when only the workspace cannot be read", async () => {
    spyOnConsoleError();
    stubApi({ health: true, workspace: false });

    renderWithClient(<App />);

    expect(await screen.findByText("Serwer działa")).toBeInTheDocument();
    expect(await within(indicator()).findByText("Nie udało się odczytać workspace'u")).toBeInTheDocument();
  });
});
