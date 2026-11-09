import { expect, it, spyOn } from "bun:test";
import * as tailscale from "../tailscale.ts";
import { relayConnection, relayDevice, relayFixture } from "./test-helpers.ts";

it("reports the server's actual listening port for access over a relay session", async () => {
  // Given: an ephemeral listener and isolated Tailscale discovery.
  const discovery = spyOn(tailscale, "readTailscale").mockResolvedValue(null);
  const f = relayFixture({ machines: false });
  try {
    const link = await relayConnection(f);
    await link.auth(await relayDevice(f));
    // When
    const response = await link.open("/api/access").response;
    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ port: f.app.port });
  } finally {
    discovery.mockRestore();
    f.close();
  }
});
