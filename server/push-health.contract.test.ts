import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushSubscriptionStatus } from "../shared/protocol.ts";
import { TOKEN_COOKIE } from "./auth.ts";
import { createServer } from "./index.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";

/**
 * POST /api/push/status through the real server: who may read a subscription's delivery record,
 * the holder of the shared token with the subscription's own keys. Every server here keeps its
 * push state in a temp dir and delivers to the fake push service of push.fake.ts; no real device
 * is paged. The herdr session behind the server is the isolated test one (scripts/test-herdr.ts);
 * nothing here touches a pane.
 */
const guard = { "x-herdr-machine": "1", "content-type": "application/json" };
const NOT_FOUND = { error: { code: "subscription_not_found", message: "this device is not subscribed" } };

const withOtherKeys = (subscription: FakePushService["subscription"]) => ({ ...subscription, keys: { ...subscription.keys, auth: Buffer.alloc(16, 9).toString("base64url") } });

async function status(base: string, headers: Record<string, string>, subscription: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/api/push/status`, { method: "POST", headers: { ...guard, ...headers }, body: JSON.stringify({ subscription }) });
  return { status: response.status, body: await response.json() };
}

it("answers the token holder about a subscription it holds the keys of, and nobody else", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-push-health-"));
  // the push service's clock: advanced by the test, so two deliveries never share a millisecond by chance
  let clock = Date.now();
  const server = createServer({ port: 0, stateDir: root, token: "test-push-health", machines: false, pushLoopbackHttp: true, statusNow: () => clock });
  const base = `http://127.0.0.1:${server.port}`;
  const owner = { cookie: `${TOKEN_COOKIE}=test-push-health` };
  const phone = await startFakePushService();
  const desk = await startFakePushService();
  try {
    // registered, then the test push it sent is its last success
    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, ...owner }, body: JSON.stringify({ subscription: phone.subscription }) })).status).toBe(204);
    expect(await status(base, owner, phone.subscription)).toEqual({ status: 200, body: { registered: true, last_success_at: null, last_failure_at: null, last_failure: null } });
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: { ...guard, ...owner }, body: JSON.stringify({ endpoint: phone.subscription.endpoint }) })).status).toBe(204);
    await phone.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    const own = await status(base, owner, phone.subscription);
    expect(own.status).toBe(200);
    expect((own.body as PushSubscriptionStatus).registered).toBe(true);
    expect((own.body as PushSubscriptionStatus).last_success_at).not.toBeNull();
    expect((own.body as PushSubscriptionStatus).last_failure).toBeNull();

    // an unknown endpoint and the wrong keys get the unknown subscription's answer
    const unknown = await status(base, owner, { ...phone.subscription, endpoint: `${phone.subscription.endpoint}-never-known` });
    expect(unknown).toEqual({ status: 404, body: NOT_FOUND });
    expect(await status(base, owner, withOtherKeys(phone.subscription))).toEqual(unknown);

    // the Bearer token proves itself with the exact keys too
    const bearer = { authorization: "Bearer test-push-health" };
    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, ...bearer }, body: JSON.stringify({ subscription: desk.subscription }) })).status).toBe(204);
    expect(await status(base, bearer, desk.subscription)).toEqual({ status: 200, body: { registered: true, last_success_at: null, last_failure_at: null, last_failure: null } });
    expect(await status(base, bearer, withOtherKeys(desk.subscription))).toEqual(unknown);

    // a retired subscription answers the holder of its keys with why, and nobody else
    clock += 1000;
    phone.answerWith(410);
    const retired = await fetch(`${base}/api/push/test`, { method: "POST", headers: { ...guard, ...owner }, body: JSON.stringify({ endpoint: phone.subscription.endpoint }) });
    expect(retired.status).toBe(410);
    const tombstone = await status(base, owner, phone.subscription);
    expect(tombstone.status).toBe(200);
    expect(tombstone.body).toEqual({ registered: false, last_success_at: new Date(clock - 1000).toISOString(), last_failure_at: new Date(clock).toISOString(), last_failure: "gone" });
    expect(await status(base, owner, withOtherKeys(phone.subscription))).toEqual(unknown);
    // the record names neither the endpoint nor the keys
    const raw = readFileSync(join(root, "push-delivery.json"), "utf8");
    expect(raw).not.toContain(phone.subscription.endpoint);
    expect(raw).not.toContain(phone.subscription.keys.auth);

    // the shape of the request: a subscription, never an endpoint in the address or a list
    const malformed = await status(base, owner, { endpoint: phone.subscription.endpoint });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "invalid_subscription" } });
    expect((await fetch(`${base}/api/push/status`, { headers: { ...guard, ...owner } })).status).toBe(400);
    expect((await fetch(`${base}/api/push/status?endpoint=${encodeURIComponent(phone.subscription.endpoint)}`, { headers: { ...guard, ...owner } })).status).toBe(400);
  } finally { phone.stop(); desk.stop(); server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("tells a request without the token nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-push-health-gate-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-push-health-gate", machines: false, pushLoopbackHttp: true });
  const base = `http://127.0.0.1:${server.port}`;
  const fake = await startFakePushService();
  try {
    const owner = { cookie: `${TOKEN_COOKIE}=test-push-health-gate` };
    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, ...owner }, body: JSON.stringify({ subscription: fake.subscription }) })).status).toBe(204);
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: { ...guard, ...owner }, body: JSON.stringify({ endpoint: fake.subscription.endpoint }) })).status).toBe(204);
    await fake.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    expect((await status(base, owner, fake.subscription)).status).toBe(200);

    // no token, a forwarded one, a wrong one: the gate answers before any subscription is looked at
    for (const headers of [{}, { "x-forwarded-for": "192.0.2.1" }, { cookie: `${TOKEN_COOKIE}=wrong` }, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
      const stranger = await fetch(`${base}/api/push/status`, { method: "POST", headers: { ...guard, ...headers }, body: JSON.stringify({ subscription: fake.subscription }) });
      expect(stranger.status).toBe(401);
    }
    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: guard, body: JSON.stringify({ subscription: fake.subscription }) })).status).toBe(401);
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: guard, body: JSON.stringify({ endpoint: fake.subscription.endpoint }) })).status).toBe(401);
  } finally { fake.stop(); server.stop(); rmSync(root, { recursive: true, force: true }); }
});
