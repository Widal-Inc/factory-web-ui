import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { forgetAuthAttempts } from "./auth.ts";

/**
 * The access gate at the HTTP seam: a direct loopback request with no token is let in, a request
 * a proxy forwarded is not, and a token gates everything and counts guesses. `decideAccess` itself
 * (loopback, proxy, token) is covered in server/access.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "herdr-open-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("this PC, with no token and no configuration", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let rejectionListeners = 0;
  beforeAll(() => {
    forgetAuthAttempts();
    rejectionListeners = process.listenerCount("unhandledRejection");
    server = createServer({ port: 0, stateDir: root });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  it("leaves an unhandled rejection to Bun, which exits so the supervisor sees the crash", () => {
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionListeners);
  });

  it("is let in with nothing set up: the local-dev path", async () => {
    expect((await fetch(`${base}/api/preferences`)).status).toBe(200);
  });

  it("refuses a request a proxy forwarded, which says nothing about who is behind it", async () => {
    for (const headers of [{ "x-forwarded-for": "100.64.0.9" }, { forwarded: "for=100.64.0.9" }, { via: "1.1 proxy" }, { "tailscale-funnel-request": "?1" }] as Record<string, string>[]) {
      const response = await fetch(`${base}/api/preferences`, { headers });
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("unauthorized");
    }
    // a Host that does not name this machine is a proxy rewriting the address
    expect((await fetch(`${base}/api/preferences`, { headers: { host: "app.example.test" } })).status).toBe(401);
  });

  it("lists an agent's commands for a folder on this PC's path and the proxy's", async () => {
    // a folder with one Codex skill: its description is file text the terminal never showed
    const folder = join(root, "commands-folder");
    mkdirSync(join(folder, ".codex", "skills", "sentinel-skill"), { recursive: true });
    writeFileSync(join(folder, ".codex", "skills", "sentinel-skill", "SKILL.md"), "---\nname: sentinel-skill\ndescription: SENTINEL-DESCRIPTION\n---\nBody.\n");
    for (const path of ["/api/agent/commands", "/api/machines/local/agent/commands"]) {
      const listed = await fetch(`${base}${path}?agent=codex&cwd=${encodeURIComponent(folder)}`, { headers: { origin: base } });
      expect(listed.status, path).toBe(200);
      expect((await listed.json() as { commands: { name: string; description: string }[] }).commands).toContainEqual(expect.objectContaining({ name: "sentinel-skill", description: "SENTINEL-DESCRIPTION" }));
    }
  });

  it("answers a pane read outside the enums, and the route's own method check", async () => {
    const read = await fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=bogus`);
    expect(read.status).toBe(400);
    expect((await read.json() as { error: { code: string } }).error.code).toBe("invalid_source");
    const format = await fetch(`${base}/api/pane/read?pane_id=w9999:p9999&format=markdown`);
    expect((await format.json() as { error: { code: string } }).error.code).toBe("invalid_format");
    const posted = await fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=visible`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" } });
    expect(posted.status).toBe(400);
    expect((await posted.json() as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });

  it("gives an agent's folder commands no route under a trailing slash, an empty segment or an encoded slash", async () => {
    const folder = encodeURIComponent(root);
    // a trailing slash or an empty segment is no route at all (nonCanonicalPath)
    for (const path of ["/api/agent/commands/", "/api/machines/m1/agent/commands/", "/api/agent//commands", "/api/machines/m1//agent/commands", "/api/machines//m1/agent/commands", "/api/machines/m1/agent/commands///"]) {
      const response = await fetch(`${base}${path}?agent=claude&cwd=${folder}`, { headers: { origin: base } });
      expect(response.status, path).toBe(404);
      expect((await response.json() as { error: { code: string } }).error.code, path).toBe("not_found");
    }
    // an encoded slash names no route here or on another PC: nothing is listed
    for (const path of ["/api/agent%2Fcommands", "/api/agent%2fcommands/", "/api/machines/m1/agent%2Fcommands", "/api/machines/m1%2Fagent/commands"]) {
      const response = await fetch(`${base}${path}?agent=claude&cwd=${folder}`, { headers: { origin: base } });
      expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(await response.text(), path).not.toContain('"commands"');
    }
  });
});

describe("a token set: guessing it", () => {
  const TOKEN = "the-right-token-for-this-test";
  let server: ReturnType<typeof createServer>;
  let base: string;
  const stateDir = mkdtempSync(join(root, "token-"));
  beforeAll(() => {
    forgetAuthAttempts();
    // a held answer is a wait of one second: the clock stands still, so a slow run cannot outlast it
    setSystemTime(Date.now());
    server = createServer({ port: 0, stateDir, token: TOKEN });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); setSystemTime(); });
  const probe = (bearer: string, via?: string): Promise<Response> =>
    fetch(`${base}/api/preferences`, { headers: { authorization: `Bearer ${bearer}`, ...(via ? { "x-forwarded-for": via } : {}) } });

  it("lets nothing in without the token, this PC included", async () => {
    expect((await fetch(`${base}/api/preferences`)).status).toBe(401);
    expect((await probe(TOKEN)).status).toBe(200);
  });

  it("holds a run of wrong Bearer tokens back on every route, not only the sign-in form", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await probe(`wrong-${attempt}`, "100.64.0.1")).status).toBe(401);
    // inside the wait even the right token is not compared, so a guess learns nothing
    const held = await probe(TOKEN, "100.64.0.1");
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts guesses that arrive together", async () => {
    const statuses = (await Promise.all(Array.from({ length: 12 }, (_, attempt) => probe(`together-${attempt}`, "100.64.0.4")))).map((response) => response.status);
    expect(statuses.filter((status) => status === 401).length).toBe(5);
    expect(statuses.filter((status) => status === 429).length).toBe(7);
  });

  it("reads a cookie-bearing mutation that states no Origin as cross-site, unless it carries the custom mutation header", async () => {
    const url = `${base}/api/pane/read?pane_id=w9999:p9999&source=visible`;
    const cookie = `ovis_token=${TOKEN}`;
    const bare = await fetch(url, { method: "POST", headers: { cookie } });
    expect(bare.status).toBe(403);
    expect((await bare.json() as { error: { code: string } }).error.code).toBe("invalid_origin");
    // the custom header is that client's proof: it passes the origin gate, and the route's own method check answers next
    const cli = await fetch(url, { method: "POST", headers: { cookie, "x-herdr-machine": "1" } });
    expect(cli.status).toBe(400);
    expect((await cli.json() as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });

  it("keeps each visitor behind a proxy on this PC apart, by the address the proxy saw", async () => {
    expect((await probe(TOKEN, "100.64.0.2")).status).toBe(200);
  });

  it("lets the owner sign in while their cookie's wait runs, and the sign-in spends it", async () => {
    const cookie = { cookie: "ovis_token=stale-token", "x-forwarded-for": "100.64.0.3" };
    for (let attempt = 0; attempt < 6; attempt += 1) await fetch(`${base}/api/health`, { headers: cookie });
    const signIn = await fetch(`${base}/api/auth`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-forwarded-for": "100.64.0.3" }, body: JSON.stringify({ token: TOKEN }) });
    expect(signIn.status).toBe(204);
    expect((await probe(TOKEN, "100.64.0.3")).status).toBe(200);
  });
});
