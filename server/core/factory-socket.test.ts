import { expect, it } from "bun:test";
import { factoryFixture } from "../factory-auth.fake.ts";
import { connectionData, type Client } from "./connections.ts";
import { factorySocket } from "./factory-socket.ts";
import type { SocketHandler } from "./socket.ts";

async function harness() {
  const f = factoryFixture();
  const sent: string[] = [];
  const actions: string[] = [];
  const closed = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let client!: Client;
  let closes = 0;
  const raw: Client = {
    data: connectionData({ factoryIdentity: await f.auth.identity(f.token()) }), readyState: 1,
    send: (data) => { sent.push(data); delivered.resolve(); return 1; },
    getBufferedAmount: () => 0,
    close: () => { closed.resolve(); },
  };
  const handlers: SocketHandler = {
    open: (connection) => { client = connection; },
    message: (_connection, message) => { actions.push(String(message)); },
    close: () => { closes++; }, drain: () => {},
  };
  const socket = factorySocket(handlers, f.auth);
  await socket.open(raw);
  return { f, raw, client, socket, sent, actions, closed: closed.promise, delivered: delivered.promise, closes: () => closes };
}

it("authorizes each incoming frame and stops existing connections on revocation", async () => {
  const h = await harness();
  await h.socket.message(h.raw, '{"type":"ping","id":1}');
  expect(h.actions).toHaveLength(1);
  h.f.setMe({}, 403);
  await h.socket.message(h.raw, '{"type":"input","text":"never typed"}');
  await h.closed;
  expect(h.actions).toHaveLength(1);
  expect(h.closes()).toBe(1);
  await expect(h.client.data.factoryAuthorize!()).rejects.toThrow();
  h.socket.close(h.raw, 1008, "closed");
  expect(h.closes()).toBe(1);
});

it("checks outgoing data even when no new browser message arrives", async () => {
  const h = await harness();
  expect(h.client.send("first")).toBe(-1);
  await h.delivered;
  expect(h.sent).toEqual(["first"]);
  h.f.setMe({}, 403);
  h.client.send("private transcript");
  await h.closed;
  expect(h.sent).toEqual(["first"]);
  expect(h.closes()).toBe(1);
});

it("expires a signed connection and never sends buffered data on failure", async () => {
  const h = await harness();
  h.f.advance(3600_001);
  h.client.send("expired transcript");
  await h.closed;
  expect(h.sent).toEqual([]);
  expect(h.f.audits).toContainEqual(expect.objectContaining({ actor: "ada@example.test", action: "websocket.close", outcome: "denied" }));
});

it("closes an idle connection after registry removal without waiting for browser activity", async () => {
  const h = await harness();
  h.f.setMe({}, 403);
  await h.closed;
  expect(h.sent).toEqual([]);
  expect(h.actions).toEqual([]);
});

it("bounds pending outgoing frames while ownership lookup is stalled", async () => {
  const h = await harness();
  for (let i = 0; i < 257; i++) h.client.send("bounded");
  await h.closed;
  expect(h.sent).toEqual([]);
  expect(h.closes()).toBe(1);
});
