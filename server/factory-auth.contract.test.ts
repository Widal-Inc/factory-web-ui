import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { FactoryAuth } from "./factory-auth.ts";
import { factoryFixture } from "./factory-auth.fake.ts";
import { createServer } from "./index.ts";

// These are transport tests with a synthetic identity/registry, never the user's herdr or real AWS.
const restoreHerdr = unitHerdrOnly();
afterAll(restoreHerdr);

describe("the factory gate before every route", () => {
  const f = factoryFixture();
  let app: ReturnType<typeof createServer>;
  let stateDir: string;
  let ctx: ServerContext;
  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "factory-http-"));
    app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, sidecar: false, machines: false, factoryAuth: f.auth, token: "fixture-legacy-token" });
    ctx = { ...app.context, requestIP: () => ({ address: "10.1.2.4" }), timeout: () => {}, upgrade: () => true };
  });
  afterAll(() => { app.stop(); rmSync(stateDir, { recursive: true, force: true }); });

  it("denies HTTP APIs, static assets, media and upgrades without signed identity", async () => {
    for (const path of ["/", "/index.html", "/assets/app.js", "/sw.js", "/manifest.webmanifest", "/api/auth", "/api/health?scope=full", "/api/preferences", "/api/pane/read?pane_id=p", "/api/pane/image?pane_id=p", "/api/fs/file", "/api/machines/events", "/api/pane/prompt/answer", "/ws"]) {
      const request = f.request(path, { headers: { authorization: "Bearer fixture-legacy-token", cookie: "ovis_token=fixture-legacy-token" } });
      request.headers.delete("x-amzn-oidc-data");
      const response = await handleRequest(request, ctx);
      expect(response?.status, path).toBe(401);
      expect(await response?.text(), path).not.toContain("fixture-legacy-token");
    }
    expect((await handleRequest(f.request("/api/preferences", { headers: { "x-amzn-oidc-data": "forged.header.signature" } }), ctx))?.status).toBe(401);
    expect((await handleRequest(f.request("/api/preferences", { headers: { "x-amzn-oidc-data": f.token({ exp: 0 }) } }), ctx))?.status).toBe(401);
  });

  it("never lets loopback or a bridge token bypass factory identity", async () => {
    const actual = await fetch(`http://127.0.0.1:${app.port}/api/preferences`, { headers: { authorization: "Bearer fixture-legacy-token" } });
    expect(actual.status).toBe(403);
    const loopback = { ...ctx, requestIP: () => ({ address: "127.0.0.1" }) };
    expect((await handleRequest(f.request(), loopback))?.status).toBe(403);
    const unsignedHealth = new Request(`${f.options.origin}/api/health`);
    const probe = await handleRequest(unsignedHealth, ctx);
    expect(await probe?.json()).toEqual({ ok: true });
    expect((await handleRequest(unsignedHealth, loopback))?.status).toBe(403);
  });

  it("allows the owner from the public hub origin and removes local sign-in", async () => {
    const response = await handleRequest(f.request(), ctx);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBe(f.options.hubOrigin);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    await response?.body?.cancel();
    const signedHealth = await handleRequest(f.request("/api/health?scope=bridge"), ctx);
    expect((await signedHealth?.json() as { auth: unknown }).auth).toMatchObject({ authenticated: true, via: "alb" });
    expect((await handleRequest(f.request("/api/auth", { method: "POST" }), ctx))?.status).toBe(404);
    expect((await handleRequest(f.request("/ws"), ctx))).toBeUndefined();
    expect((await handleRequest(f.request("/api/preferences", { method: "OPTIONS" }), ctx))?.status).toBe(204);
    expect((await handleRequest(f.request("/api/preferences", { method: "POST", headers: { origin: "https://evil.example.test" } }), ctx))?.status).toBe(403);
  });

  it("refuses even an admin after ownership is removed, including reconnect", async () => {
    f.setMe({ person: f.options.owner, role: "admin", factories: [] });
    for (const path of ["/api/preferences", "/api/health", "/", "/ws"]) expect((await handleRequest(f.request(path), ctx))?.status, path).toBe(403);
    expect(f.audits.some((event) => event.outcome === "denied")).toBe(true);
    expect(JSON.stringify(f.audits)).not.toContain("fixture-legacy-token");
  });
});

it("closes a real WebSocket on removal and refuses its next upgrade", async () => {
  const f = factoryFixture();
  // A loopback stand-in for the trusted ALB peer; production never adds this test subnet.
  const auth = new FactoryAuth({ ...f.options, trustedProxyCidrs: ["127.0.0.1/32"] });
  const stateDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, sidecar: false, machines: false, factoryAuth: auth });
  let ws: WebSocket | undefined;
  try {
    const first = Promise.withResolvers<string>();
    const closed = Promise.withResolvers<number>();
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    ws = new RuntimeSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: Object.fromEntries(f.request("/ws").headers) });
    ws.onmessage = (event) => first.resolve(String(event.data));
    ws.onclose = (event) => closed.resolve(event.code);
    ws.onerror = () => first.reject(new Error("fixture upgrade failed"));
    expect(JSON.parse(await first.promise).type).toBe("features");
    f.setMe({}, 403);
    ws.send(JSON.stringify({ type: "ping", id: 1 }));
    expect(await closed.promise).toBe(1008);
    const response = await fetch(`http://127.0.0.1:${app.port}/ws`, { headers: f.request("/ws").headers });
    expect(response.status).toBe(403);
  } finally { ws?.close(); app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
