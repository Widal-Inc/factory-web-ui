import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { authenticatedWebSocket } from "./remote-websocket.ts";

async function connection(base: string, open?: (url: string) => WebSocket) {
  const frames: ServerMessage[] = [];
  const socket = (open ?? ((url) => authenticatedWebSocket(url, "test-token")))(base.replace("http:", "ws:") + "/ws");
  const waiting = new Set<() => void>();
  socket.onmessage = (event) => { frames.push(JSON.parse(String(event.data)) as ServerMessage); for (const check of waiting) check(); };
  const wait = (matches: (frame: ServerMessage) => boolean) => new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(check); reject(new Error("machine event did not arrive")); }, 5_000);
    const check = () => { const frame = frames.find(matches); if (frame) { clearTimeout(timer); waiting.delete(check); resolve(frame); } };
    waiting.add(check); check();
  });
  const features = await wait((frame) => frame.type === "features");
  // a ping answered after a frame was sent proves the server has handled it, without a sleep
  let pings = 0;
  const fence = async () => { const id = ++pings; socket.send(JSON.stringify({ type: "ping", id })); await wait((frame) => frame.type === "pong" && frame.id === id); };
  return { socket, frames, wait, features, fence };
}

it("multiplexes initial documents and live updates onto the existing authenticated socket", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token" });
  const base = `http://127.0.0.1:${server.port}`;
  const client = await connection(base);
  try {
    expect(client.features.type === "features" && client.features.features).toContain("machine-events");
    expect(client.frames.some((frame) => frame.type === "machine-event")).toBe(false);
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "preferences");
    await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "machines");
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    const change = await fetch(base + "/api/preferences", {
      method: "PUT", headers: { authorization: "Bearer test-token", origin: base, "content-type": "application/json" },
      body: JSON.stringify({ settings: { language: "ko" } }),
    });
    expect(change.status).toBe(200);
    const revision = (await change.json()).revision;
    await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "preferences" && frame.event.preferences.revision === revision);
    expect(client.frames.filter((frame) => frame.type === "machine-event" && frame.event.type === "preferences" && frame.event.preferences.revision === revision)).toHaveLength(1);
    // A ping fences unsubscribe, without a sleep or any terminal input.
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: false }));
    client.socket.send(JSON.stringify({ type: "ping", id: 23 }));
    await client.wait((frame) => frame.type === "pong" && frame.id === 23);
    const before = client.frames.filter((frame) => frame.type === "machine-event").length;
    await fetch(base + "/api/preferences", { method: "PUT", headers: { authorization: "Bearer test-token", origin: base, "content-type": "application/json" }, body: JSON.stringify({ settings: { language: "en" } }) });
    client.socket.send(JSON.stringify({ type: "ping", id: 24 }));
    await client.wait((frame) => frame.type === "pong" && frame.id === 24);
    expect(client.frames.filter((frame) => frame.type === "machine-event")).toHaveLength(before);
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: "yes" }));
    await client.wait((frame) => frame.type === "error" && frame.code === "invalid_subscription");
  } finally { client.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

it("keeps SSE available when the server's transport rollback switch disables the capability", async () => {
  const before = process.env["OVIS_MACHINE_EVENTS_WS"];
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-rollback-"));
  process.env["OVIS_MACHINE_EVENTS_WS"] = "0";
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token" });
  const base = `http://127.0.0.1:${server.port}`;
  let client: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    client = await connection(base);
    expect(client.features.type === "features" && client.features.features).not.toContain("machine-events");
    const abort = new AbortController();
    try {
      const response = await fetch(base + "/api/machines/events", { headers: { authorization: "Bearer test-token" }, signal: abort.signal });
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode((await response.body!.getReader().read()).value)).toContain('"type":"machines"');
    } finally { abort.abort(); }
  } finally {
    client?.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true });
    if (before === undefined) delete process.env["OVIS_MACHINE_EVENTS_WS"]; else process.env["OVIS_MACHINE_EVENTS_WS"] = before;
  }
});

it("gives another server's bridge no machine document, even when it asks for one", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-bridge-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", bridgeToken: "test-bridge" });
  const base = `http://127.0.0.1:${server.port}`;
  let client: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    client = await connection(base, (url) => authenticatedWebSocket(url, "test-bridge"));
    expect(client.features.type === "features" && client.features.features).not.toContain("machine-events");
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    await client.fence();
    expect(client.frames.filter((frame) => frame.type === "machine-event")).toEqual([]);
  } finally { client?.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
