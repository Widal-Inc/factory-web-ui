import { describe, expect, it } from "bun:test";

import { OWN_UPDATE_OFFER, type Machine, type RemoteOvis } from "../../shared/machines.ts";
import { machineStateLine, manageActions, ownOvisAction, ownUpdateFailure } from "./MachineSidebar.tsx";

const offer = (updatable: boolean): RemoteOvis => ({ version: "0.4.16", latest_version: updatable ? "0.4.18" : null, updatable, reason: updatable ? null : "it cannot", address: "pc.invalid:4000", url: null });
const pc = (patch: Partial<Pick<Machine, "remote_ovis" | "action_required" | "error">>) => ({ remote_ovis: null, action_required: null, error: null, ...patch });

describe("a PC's own Ovis on its card", () => {
  it("is offered only as what the PC waits for: its update, or a setup it cannot run itself", () => {
    expect(ownOvisAction(pc({ remote_ovis: offer(true), action_required: "update_bridge" }))).toEqual(offer(true));
    expect(ownOvisAction(pc({ remote_ovis: offer(false), action_required: "setup" }))).toEqual(offer(false));
    // an offer the PC no longer waits for is told the usual way (#2054)
    expect(ownOvisAction(pc({ remote_ovis: offer(true), action_required: "setup" }))).toBeNull();
    expect(ownOvisAction(pc({ remote_ovis: offer(false), action_required: "update_bridge" }))).toBeNull();
    expect(ownOvisAction(pc({ remote_ovis: offer(true), action_required: "bridge_conflict" }))).toBeNull();
    expect(ownOvisAction(pc({ remote_ovis: null, action_required: "update_bridge" }))).toBeNull();
  });

  it("tells why its last update failed, never the offer's own sentence", () => {
    const failed = "That PC's Ovis could not update itself: disk full";
    expect(ownUpdateFailure(pc({ remote_ovis: offer(true), action_required: "update_bridge", error: failed }))).toBe(failed);
    expect(ownUpdateFailure(pc({ remote_ovis: offer(true), action_required: "update_bridge", error: `${OWN_UPDATE_OFFER} to v0.4.18.` }))).toBeNull();
    expect(ownUpdateFailure(pc({ remote_ovis: offer(true), action_required: "update_bridge" }))).toBeNull();
    // a refusal is the setup card's reason, not a failed update offered again
    expect(ownUpdateFailure(pc({ remote_ovis: offer(false), action_required: "setup", error: failed }))).toBeNull();
  });
});

describe("Manage PC's menu", () => {
  type Managed = Parameters<typeof manageActions>[0];
  const ssh = (patch: Partial<Managed> = {}): Managed => ({ kind: "ssh", herdr_profile_id: undefined, enabled: true, target: { destination: "pc.invalid" }, action_required: null, ...patch });
  const ids = (machine: Managed, busy = false, canHide = true) => manageActions(machine, { busy, canHide }).map(({ id }) => id);
  const waiting = (machine: Managed, busy = false, canHide = true) => manageActions(machine, { busy, canHide }).filter(({ disabled }) => disabled).map(({ id }) => id);

  it("offers every action for a PC added here, Remove PC last", () => {
    expect(ids(ssh())).toEqual(["rename", "toggle", "setup", "update", "hide", "remove"]);
    expect(waiting(ssh())).toEqual([]);
  });

  it("keeps herdr's limits for a PC herdr manages: no rename, disconnect or removal here", () => {
    expect(ids(ssh({ herdr_profile_id: "profile" }))).toEqual(["setup", "update", "hide"]);
  });

  it("offers only Hide on this device for a machine of herdr-core, which hc machine and the Herdr app manage", () => {
    expect(ids(ssh({ kind: "hc", target: undefined }))).toEqual(["hide"]);
    expect(ids(ssh({ kind: "hc", target: undefined }), false, false)).toEqual([]);
  });

  it("leaves Hide on this device out while the PC is the last one shown", () => {
    expect(ids(ssh(), false, false)).toEqual(["rename", "toggle", "setup", "update", "remove"]);
  });

  it("keeps setup and the bridge update to the PC's own notice when that is what it waits for", () => {
    expect(ids(ssh({ action_required: "setup" }))).toEqual(["rename", "toggle", "update", "hide", "remove"]);
    expect(ids(ssh({ action_required: "connect" }))).toEqual(["rename", "toggle", "hide", "remove"]);
    expect(ids(ssh({ action_required: "update_bridge" }))).toEqual(["rename", "toggle", "setup", "update", "hide", "remove"]);
  });

  it("holds setup and the bridge update for a disabled PC, or one with no address", () => {
    expect(waiting(ssh({ enabled: false }))).toEqual(["setup", "update"]);
    expect(waiting(ssh({ target: undefined }))).toEqual(["setup", "update"]);
  });

  it("holds a rename, a connect or disconnect, Hide and a removal while one of them runs", () => {
    // hiding the PC drops its row, and with it the guard on the request still running
    expect(waiting(ssh(), true)).toEqual(["rename", "toggle", "hide", "remove"]);
    expect(waiting(ssh({ kind: "hc", target: undefined }), true)).toEqual(["hide"]);
  });
});

describe("a PC's error line", () => {
  const away = "cannot reach herdr at /home/widal/.config/herdr/herdr.sock: Failed to connect";
  const same = (words: string) => words;

  it("keeps the server's words and the step on the PC for a PC of the person's own", () => {
    expect(machineStateLine({ kind: "local", error: away }, false, same, false)).toEqual({ words: away, next: "Start herdr on this PC, or check HERDR_SOCKET." });
    expect(machineStateLine({ kind: "local", error: null }, false, same, false)).toEqual({ words: null, next: null });
  });

  it("tells a factory's owner what they can do, and names no socket, variable or PC", () => {
    const line = machineStateLine({ kind: "local", error: away }, false, same, true);
    expect(line).toEqual({ words: "Your factory is not answering right now. It reports this itself; wait a minute, then reload the page.", next: null });
    expect(JSON.stringify(line)).not.toMatch(/herdr|HERDR_SOCKET|\.sock|\/home\/|\bPC\b/);
    expect(machineStateLine({ kind: "local", error: "Failed to connect" }, false, same, true).words).toBe(line.words);
    expect(machineStateLine({ kind: "local", error: null }, false, same, true)).toEqual({ words: null, next: null });
  });
});
