import { describe, expect, it, vi } from "vitest";

import { createRestClient } from "../src/rest";

describe("rest client", () => {
  it("performs typed requests against the API", async () => {
    const potsResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue([
        {
          id: "pot-1",
          name: "Mint",
          soilMoisture: 42,
          temperature: 21,
          battery: 85,
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ])
    } as const;

    const commandResponse = {
      ok: true,
      status: 204,
      statusText: "No Content",
      json: vi.fn()
    } as const;

    const fetchMock = vi
      .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(potsResponse as unknown as Response)
      .mockResolvedValueOnce(commandResponse as unknown as Response);

    const client = createRestClient({ baseUrl: "https://api.example.com", fetchImpl: fetchMock });

    const pots = await client.listPots();
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/pots", expect.objectContaining({ method: "GET" }));
    expect(pots).toHaveLength(1);
    expect(pots[0].id).toBe("pot-1");

    await client.sendCommand({ type: "pump", potId: "pot-1" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.example.com/command",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "pump", potId: "pot-1" })
      })
    );
  });
});
