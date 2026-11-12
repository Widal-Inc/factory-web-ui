import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

it("serves owner files to the configured hub with browser metadata, preserving file isolation", async () => {
  const f = factoryFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "factory-files-"));
  const file = join(stateDir, "report.html");
  writeFileSync(file, "<!doctype html><h1>Fixture report</h1>");
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, sidecar: false, machines: false, factoryAuth: f.auth });
  const ctx = { ...app.context, requestIP: () => ({ address: "10.1.2.4" }), timeout: () => {}, upgrade: () => false };
  const path = `/api/fs/file?path=${encodeURIComponent(file)}`;
  const ask = async (route: string, headers: Record<string, string>, omitOrigin = false) => {
    const request = f.request(route, { headers });
    if (omitOrigin) request.headers.delete("origin");
    return (await handleRequest(request, ctx))!;
  };
  try {
    for (const site of ["same-site", "cross-site"]) {
      for (const route of [path, `/api/fs/stat?path=${encodeURIComponent(file)}`, `/api/fs/favicon?root=${encodeURIComponent(stateDir)}`]) {
        const response = await ask(route, { "sec-fetch-site": site, "sec-fetch-mode": "cors" });
        expect(response.status, `${site} ${route}`).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe(f.options.hubOrigin);
        await response.body?.cancel();
      }
    }
    // Images/audio/video issue no-cors reads without Origin; the referrer must be the hub.
    const mediaHeaders = { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", referer: `${f.options.hubOrigin}/factory` };
    const media = await ask(path, mediaHeaders, true);
    expect(media.status).toBe(200);
    expect(await media.text()).toContain("Fixture report");
    for (const referer of [f.options.origin, "https://unrelated.example.test", `${f.options.hubOrigin}.unrelated.test`, "invalid", ""]) {
      const response = await ask(path, { ...mediaHeaders, referer }, true);
      expect(response.status, referer).toBe(403);
      await response.body?.cancel();
    }
    const opaque = await ask(path, { ...mediaHeaders, origin: "null" });
    expect(opaque.status).toBe(403);
    await opaque.body?.cancel();
    const unrelated = await ask(path, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", origin: "https://unrelated.example.test" });
    expect(unrelated.status).toBe(403);
    await unrelated.body?.cancel();
    // An iframe navigation often omits Origin. Its allowed ancestor still comes from config.
    const rendered = await ask(`${path}&render=1`, { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" }, true);
    expect(rendered.status).toBe(200);
    const policy = rendered.headers.get("content-security-policy")!;
    expect(policy).toContain(`frame-ancestors 'self' ${f.options.hubOrigin}`);
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("allow-same-origin");
    expect(await rendered.text()).toContain("Fixture report");
    const unsigned = f.request(path, { headers: mediaHeaders });
    unsigned.headers.delete("x-amzn-oidc-data");
    expect((await handleRequest(unsigned, ctx))?.status).toBe(401);
    f.setMe({ person: f.options.owner, role: "admin", factories: [] });
    const removed = await ask(path, mediaHeaders, true);
    expect(removed.status).toBe(403);
    await removed.body?.cancel();
  } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
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
