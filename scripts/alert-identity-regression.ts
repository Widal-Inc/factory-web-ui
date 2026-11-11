/** Stored PC mutes against a test server; no real notification destinations or SSH connections. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { openSettingsPage } from "./settings-page.ts";

export async function checkAlertIdentitySettings(browser: Browser): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "alert-identity-browser-"));
  const localId = "a".repeat(32), remoteId = "b".repeat(32);
  mkdirSync(join(stateDir, "relay"));
  writeFileSync(join(stateDir, "relay", "identity.json"), JSON.stringify({ v: 1, server_id: localId }));
  writeFileSync(join(stateDir, "machines.json"), JSON.stringify([{ id: "11111111-1111-4111-8111-111111111111", name: "Renamed lab", enabled: false, target: { destination: "lab.example" }, server_id: remoteId }]));
  const server = createServer({ stateDir, hostname: "127.0.0.1", port: 0, token: "", usage: new UsageService(undefined, []) });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      try {
        await context.addInitScript(({ localId, remoteId }) => {
          if (localStorage.getItem("ovis:alert-filters") === null) localStorage.setItem("ovis:alert-filters", JSON.stringify({ pcsOff: [localId, remoteId, "Other PC"] }));
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
        }, { localId, remoteId });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.port}/?settings=alerts`);
        await page.locator(".conn-live").waitFor();
        await openSettingsPage(page, "Alerts");
        const local = page.getByRole("switch", { name: `Alerts from ${hostname()}`, exact: true });
        const remote = page.getByRole("switch", { name: "Alerts from Renamed lab", exact: true });
        await local.waitFor();
        await remote.waitFor();
        assert.equal(await local.getAttribute("aria-checked"), "false");
        assert.equal(await remote.getAttribute("aria-checked"), "false");
        await remote.click();
        assert.equal(await remote.getAttribute("aria-checked"), "true");
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:alert-filters")!).pcsOff), [localId, "Other PC"]);
        await remote.click();
        await page.reload();
        await page.locator(".conn-live").waitFor();
        await page.keyboard.press("ControlOrMeta+Shift+Comma");
        await openSettingsPage(page, "Alerts");
        assert.equal(await remote.getAttribute("aria-checked"), "false");
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:alert-filters")!).pcsOff), [localId, "Other PC", remoteId]);
        console.log(`PASS saved local/SSH identity mutes, explicit unmute and reload: ${width}`);
      } finally { await context.close(); }
    }
  } finally { server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
}
