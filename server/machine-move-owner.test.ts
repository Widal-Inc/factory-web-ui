import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { createServer } from "./index.ts";
import type { MachineManager } from "./machines.ts";

// Another PC's move is for whoever got in: this PC itself or the token's holder. Never a visitor from
// another address with no token. The PC behind the proxy is offline here, so the owner's requests end at
// "disconnected", and nobody else's gets that far.
afterAll(unitHerdrOnly());
const root = mkdtempSync(join(tmpdir(), "ovis-move-owner-"));
const TOKEN = "fictional-owner-token";
// tokenless: this PC itself, and a visitor from the network
const open = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "open"), token: "", machines: false, sidecar: false });
// with a token, which gates everything
const secured = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "secured"), token: TOKEN, machines: false, sidecar: false });
afterAll(() => { open.stop(); secured.stop(); rmSync(root, { recursive: true, force: true }); });
const pcs: Pick<Machine, "id" | "kind">[] = [{ id: "pc", kind: "ssh" }];
const manager = { list: () => pcs, endpoint: () => undefined, retryNow: () => {}, moveOfferSoon: () => {} } as unknown as MachineManager;

const OWNERS = ["this PC", "the token"] as const;
const OTHERS = ["a visitor with no token"] as const;
type Kind = typeof OWNERS[number] | typeof OTHERS[number];
const lan = { address: "192.168.0.20", family: "IPv4", port: 1 };
const loopback = { address: "127.0.0.1", family: "IPv4", port: 1 };

function contextFor(kind: Kind): ServerContext {
  const app = kind === "the token" ? secured : open;
  const base = { ...app.context, services: { ...app.context.services, core: { ...app.context.services.core, machines: manager } }, timeout: () => {} };
  return { ...base, requestIP: () => kind === "this PC" ? loopback : lan };
}
function headersFor(kind: Kind, extra: Record<string, string>): Record<string, string> {
  // a request with no Host came through a proxy (access.ts cameThroughProxy): this PC's own browser names it
  const origin = { origin: "http://127.0.0.1", host: "127.0.0.1", "x-herdr-machine": "1", "content-type": "application/json", ...extra };
  return kind === "the token" ? { ...origin, authorization: `Bearer ${TOKEN}` } : origin;
}
const ask = async (kind: Kind, path: string, method = "GET", extra: Record<string, string> = {}, body?: unknown) => {
  const response = await handleRequest(new Request(`http://127.0.0.1/api/machines/${path}`, { method, headers: headersFor(kind, extra), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), contextFor(kind));
  if (!response) throw new Error("no answer");
  const answer = await response.json() as { error?: { code: string } };
  return [response.status, answer.error?.code ?? null];
};

const update = { "x-herdr-update": "1" };
const plans = { plans: [{ machine_id: "pc", revision: "shown" }] };
const ROUTES = [["pc/runtime/move", "GET"], ["pc/runtime/move", "POST"], ["pc/runtime/move/stop", "POST"], ["pc/runtime/move/stop-all", "POST"], ["pc/runtime/move/install", "POST"], ["runtime/move-all", "POST"]] as const;
const bodyFor = (path: string, method: string) => method === "GET" ? undefined : path === "runtime/move-all" ? plans : {};

it("each kind of access is the one it names", async () => {
  const auth = async (kind: Kind) => {
    const response = await handleRequest(new Request("http://127.0.0.1/api/health?scope=bridge", { headers: headersFor(kind, {}) }), contextFor(kind));
    return (await response!.json() as { auth: { via: string } }).auth.via;
  };
  expect(await Promise.all(OWNERS.map(auth))).toEqual(["local", "token"]);
});

it("lets this PC and the token's holder move another PC or every PC; never a visitor with no token", async () => {
  for (const kind of OWNERS) {
    for (const [path, method] of ROUTES) {
      // as far as the PC, which is offline here; move-all answers for it
      const expected = path === "runtime/move-all" ? [202, null] : [503, "machine_offline"];
      expect([kind, path, method, ...await ask(kind, path, method, update, bodyFor(path, method))]).toEqual([kind, path, method, ...expected]);
    }
  }
  for (const kind of OTHERS) {
    for (const [path, method] of ROUTES) {
      const [status] = await ask(kind, path, method, update, bodyFor(path, method));
      expect([kind, path, method, status]).toEqual([kind, path, method, 401]);
    }
  }
});

it("takes the owner's change to another PC's move only from this app's own page, with no query", async () => {
  for (const kind of OWNERS) {
    expect(await ask(kind, "pc/runtime/move", "POST", {}, { revision: "shown" })).toEqual([403, "forbidden"]);
    expect(await ask(kind, "runtime/move-all", "POST", {}, plans)).toEqual([403, "forbidden"]);
    // refused by the one guard over every change to this PC's PCs (machine-api.ts), as an update with a query is
    expect((await ask(kind, "pc/runtime/move?x=1", "POST", update, { revision: "shown" }))[0]).toBe(403);
    expect((await ask(kind, "runtime/move-all?x=1", "POST", update, plans))[0]).toBe(403);
  }
});
