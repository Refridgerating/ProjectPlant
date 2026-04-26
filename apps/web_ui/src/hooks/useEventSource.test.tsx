import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HubApiError } from "../api/hubClient";
import * as hubClient from "../api/hubClient";
import { useEventStore } from "../state/eventStore";
import { useEventSource } from "./useEventSource";

function Harness({ enabled, authKey }: { enabled: boolean; authKey: string }) {
  useEventSource(enabled, authKey);
  return null;
}

function installMockEventSource() {
  const instances: Array<{ url: string; close: ReturnType<typeof vi.fn> }> = [];
  class MockEventSource {
    url: string;
    close = vi.fn();

    constructor(url: string) {
      this.url = url;
      instances.push({ url, close: this.close });
    }

    addEventListener = vi.fn();
    removeEventListener = vi.fn();
  }

  vi.stubGlobal("EventSource", MockEventSource);
  return instances;
}

describe("useEventSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEventStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    useEventStore.getState().clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stops retrying on auth failures until the auth key changes", async () => {
    const eventSources = installMockEventSource();
    const fetchEventTokenMock = vi
      .spyOn(hubClient, "fetchEventToken")
      .mockRejectedValueOnce(new HubApiError("Invalid bearer token", 401))
      .mockResolvedValueOnce({
        access_token: "fresh-event-token",
        token_type: "bearer",
        expires_in: 3600,
      });

    const view = render(<Harness enabled authKey="managed:stale-token" />);

    await waitFor(() => {
      expect(fetchEventTokenMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });

    expect(fetchEventTokenMock).toHaveBeenCalledTimes(1);
    expect(eventSources).toHaveLength(0);

    view.rerender(<Harness enabled authKey="managed:fresh-token" />);

    await waitFor(() => {
      expect(fetchEventTokenMock).toHaveBeenCalledTimes(2);
    });

    expect(eventSources).toHaveLength(1);
    expect(eventSources[0]?.url).toContain("/api/v1/events/stream?token=fresh-event-token");
  });
});
