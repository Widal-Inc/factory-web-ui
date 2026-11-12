import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";

// GET /api/machines/ssh-candidates on a live server: this PC's own window gets the list, a request from the LAN
// that is not signed in does not (server/dispatch.ts, server/machine-api.ts)
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function sshDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-candidates-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** `tailscale status --json` with this PC as user 1 and the named peers online, of the same login */
const status = (peers: string[]): string => JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "self.tail.ts.net.", UserID: 1 },
  Peer: Object.fromEntries(peers.map((name, index) => [`k${index}`, { DNSName: `${name}.tail.ts.net.`, UserID: 1, Online: true, OS: "linux" }])),
});

it("answers this PC's window with the list, and refuses a LAN request that is not signed in", async () => {
  const dir = sshDir({ config: "Host nuc12\n  HostName 100.127.218.1\n  User rise\nHost *\n" });
  const state = sshDir({});
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: "", sidecar: false, registerBridge: false,
    sshCandidates: { sshDir: dir, readStatus: async () => status(["winvm"]) } });
  cleanup.push(() => { void server.stop(); });
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/api/machines/ssh-candidates`, { headers: { origin: base } });
  expect(owner.status).toBe(200);
  expect((await owner.json() as { pcs: { destination: string }[] }).pcs.map((pc) => pc.destination)).toEqual(["nuc12", "winvm.tail.ts.net"]);
  const fromLan = await fetch(`${base}/api/machines/ssh-candidates`, { headers: { origin: base, host: "192.168.1.5" } });
  expect(fromLan.status).toBe(401);
  expect((await fromLan.json() as { error: { code: string } }).error.code).toBe("unauthorized");
});
