import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import { createPushService } from "./push.ts";
import { createServer } from "./index.ts";
import { UsageService } from "./usage.ts";

describe("notification identity compatibility", () => {
  it("lets an authenticated bridge retain the public notification identity without exposing the saved key", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "alert-identity-health-"));
    mkdirSync(join(stateDir, "relay"));
    writeFileSync(join(stateDir, "relay", "identity.json"), JSON.stringify({ v: 1, server_id: "a".repeat(32), secret_key: "never-expose-this" }));
    const server = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "test-owner", usage: new UsageService(undefined, []) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`, { headers: { authorization: "Bearer test-owner" } });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(JSON.parse(body).web_ui.server_id).toBe("a".repeat(32));
      expect(body).not.toContain("never-expose-this");
    } finally { server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("retains local and SSH identities through roster loading, rename, persistence and restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "alert-identity-"));
    const identityPath = join(stateDir, "relay", "identity.json");
    const localId = "a".repeat(32), remoteId = "b".repeat(32), machineId = "11111111-1111-4111-8111-111111111111";
    mkdirSync(join(stateDir, "relay"));
    const identity = JSON.stringify({ v: 1, server_id: localId, secret_key: "never-expose-this" });
    writeFileSync(identityPath, identity);
    writeFileSync(join(stateDir, "machines.json"), JSON.stringify([{ id: machineId, name: "Lab", enabled: false, target: { destination: "lab.example" }, server_id: remoteId }]));
    const managers: MachineManager[] = [];
    const open = () => {
      const manager = new MachineManager(stateDir, createPushService({ stateDir }), new CompletionTracker(null), async () => { throw new Error("offline fixture"); });
      managers.push(manager);
      return manager;
    };
    try {
      const manager = open();
      expect(manager.list().map((machine) => machine.server_id)).toEqual([localId, remoteId]);
      expect(JSON.stringify(manager.list())).not.toContain("never-expose-this");
      manager.patch(machineId, { name: "Renamed lab" });
      manager.stop();
      const restarted = open();
      expect(restarted.list().find((machine) => machine.id === machineId)).toMatchObject({ name: "Renamed lab", server_id: remoteId });
      expect(readFileSync(identityPath, "utf8")).toBe(identity);
    } finally { for (const manager of managers) manager.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("does not create the removed relay identity for a new installation", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "alert-identity-"));
    const manager = new MachineManager(stateDir, createPushService({ stateDir }), new CompletionTracker(null), async () => { throw new Error("offline fixture"); });
    try {
      expect(manager.list()[0]?.server_id).toBeUndefined();
      expect(existsSync(join(stateDir, "relay"))).toBe(false);
    } finally { manager.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});
