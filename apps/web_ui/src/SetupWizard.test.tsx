import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetupWizard from "./SetupWizard";

const isNativePlatformMock = vi.hoisted(() => vi.fn(() => false));
const discoverPiMock = vi.hoisted(() => vi.fn());
const scanProvisioningDevicesMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: isNativePlatformMock,
  },
}));

vi.mock("@projectplant/sdk", () => ({
  discoverPi: discoverPiMock,
}));

vi.mock("@projectplant/sdk/provisioning", () => ({
  EspBleProvisioner: {
    scanProvisioningDevices: scanProvisioningDevicesMock,
  },
}));

vi.mock("@projectplant/native-bridge", () => ({
  BleBridge: {
    openLocationSettings: vi.fn(),
    openBluetoothSettings: vi.fn(),
  },
}));

function renderWizard() {
  render(
    <MemoryRouter>
      <SetupWizard />
    </MemoryRouter>
  );
}

describe("SetupWizard", () => {
  beforeEach(() => {
    isNativePlatformMock.mockReset();
    isNativePlatformMock.mockReturnValue(false);
    discoverPiMock.mockReset();
    scanProvisioningDevicesMock.mockReset();
    scanProvisioningDevicesMock.mockResolvedValue([]);
  });

  it("renders the browser/manual setup path when not native", () => {
    renderWizard();

    expect(screen.getByRole("heading", { name: /setup wizard/i })).toBeInTheDocument();
    expect(screen.getByText(/choose how you plan to bring the node online/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fallback wi-fi/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /existing provisioned node/i })).toBeInTheDocument();
  });

  it("renders the native BLE provisioning path on native platforms", async () => {
    isNativePlatformMock.mockReturnValue(true);

    renderWizard();

    expect(screen.getByText(/provision an esp32 over ble/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use softap instead/i })).toBeInTheDocument();
    await waitFor(() => expect(scanProvisioningDevicesMock).toHaveBeenCalled());
  });
});
