import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthShell } from "./AuthShell";

const fetchHubInfoMock = vi.hoisted(() => vi.fn());
const fetchManagedEffectiveAccessMock = vi.hoisted(() => vi.fn());

vi.mock("./api/hubClient", () => ({
  fetchHubInfo: fetchHubInfoMock,
  fetchManagedEffectiveAccess: fetchManagedEffectiveAccessMock,
}));

vi.mock("./App", () => ({
  default: () => <div>App</div>,
}));

vi.mock("./SetupWizard", () => ({
  default: () => <div>Setup</div>,
}));

vi.mock("./components/LoginPage", () => ({
  LoginPage: () => <div>Login</div>,
}));

describe("AuthShell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "projectplant:ui:settings",
      JSON.stringify({
        mode: "live",
        authMode: "local_compat",
        controlPlaneUrl: "",
        fleetConsoleUrl: "",
      })
    );
    fetchHubInfoMock.mockReset();
    fetchHubInfoMock.mockResolvedValue({
      authMode: "local_compat",
      controlPlaneUrl: "",
    });
    fetchManagedEffectiveAccessMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not refetch hub info in a settings-changed loop when auth mode values are unchanged", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthShell />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(fetchHubInfoMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchManagedEffectiveAccessMock).not.toHaveBeenCalled();
  });
});
