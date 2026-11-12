import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { createAlertWebhook } from "./alert-webhook.ts";
import { handleRequest } from "./dispatch.ts";
import { factoryFixture } from "./factory-auth.fake.ts";
import { createServer } from "./index.ts";
import { createPushService } from "./push.ts";
import { startFakePushService } from "./push.fake.ts";

const restoreHerdr = unitHerdrOnly();
afterAll(restoreHerdr);

for (const access of ["current owner", "revoked owner", "expired identity"] as const) {
  it(`disables factory background and test notifications for ${access}, including after restart`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "factory-notifications-"));
    const device = await startFakePushService();
    let posts = 0;
    let responseStatus = 200;
    const destination = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
      posts += 1;
      return new Response(null, { status: responseStatus });
    } });
    let app: ReturnType<typeof createServer> | undefined;
    try {
      // Real persisted destinations from standalone mode, with a proven delivery path.
      const savedPush = createPushService({ stateDir, loopbackHttp: true });
      savedPush.subscribe(device.subscription);
      expect(await savedPush.sendTest(device.subscription.endpoint)).toEqual({ ok: true });
      const savedHook = createAlertWebhook({ stateDir });
      savedHook.save({ preset: "json", url: `http://127.0.0.1:${destination.port}/hook` }, undefined);
      expect(await savedHook.test()).toEqual({ ok: true });
      expect(device.received).toHaveLength(1);
      expect(posts).toBe(1);
      device.received.splice(0);
      posts = 0;
      // An attempted webhook post would fail and retry; Factory mode must never start it.
      responseStatus = 503;

      const f = factoryFixture();
      const signed = f.request();
      const pane: HerdrPane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "t1", terminal_id: "term1", agent_status: "working", terminal_title: "Private task", focused: false, revision: 0 };
      for (let restart = 0; restart < 2; restart += 1) {
        app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, sidecar: false, machines: false,
          factoryAuth: f.auth, alertTiming: { short: 0, long: 0, longTurn: 0 }, pushLoopbackHttp: true });
        const ctx = { ...app.context, requestIP: () => ({ address: "10.1.2.4" }), timeout: () => {}, upgrade: () => true };
        if (restart === 0) {
          const allowed = await handleRequest(signed.clone(), ctx);
          expect(allowed?.status).toBe(200);
          await allowed?.body?.cancel();
          if (access === "revoked owner") f.setMe({ person: f.options.owner, role: "admin", factories: [] });
          if (access === "expired identity") f.advance(3_600_001);
        }
        const response = await handleRequest(signed.clone(), ctx);
        expect(response?.status).toBe(access === "current owner" ? 200 : access === "revoked owner" ? 403 : 401);
        await response?.body?.cancel();

        // The independent collector invokes these services without an HTTP identity context.
        const { push, alertWebhook } = ctx.services.core;
        expect(await push.sendTest(device.subscription.endpoint)).toEqual({ ok: false, status: 403, gone: false });
        expect(await alertWebhook.test()).toEqual({ ok: false, error: "external alerts disabled", retry: false });
        push.seed([pane]);
        await push.onStatus(pane.pane_id, "blocked");
        await push.settled();
        await push.onStatus(pane.pane_id, "done");
        await push.settled();
        await push.onFailed(pane.pane_id);
        await push.settled();
        await push.onEnded(pane.pane_id);
        await push.settled();
        alertWebhook.send({ kind: "input", title: "Private task", body: "Private prompt", pane_id: pane.pane_id });
        await alertWebhook.settled();
        expect(device.received).toHaveLength(0);
        expect(posts).toBe(0);
        // Disabling delivery does not erase destinations or report successful delivery.
        expect(push.status(device.subscription)?.registered).toBe(true);
        expect(alertWebhook.view().configured).toBe(true);
        expect(alertWebhook.view().last_success_at).toBeNull();
        app.stop();
        app = undefined;
      }
    } finally {
      app?.stop();
      destination.stop(true);
      device.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}
