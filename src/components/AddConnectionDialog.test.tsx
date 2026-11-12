import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { connectTabs, SshTab } from "./AddConnectionDialog.tsx";
import { PhonePanel } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";

// Add a connection: the Tailscale address's QR code waits behind Show QR code on a phone, and the SSH tab lists the PCs found.
describe("Add a connection", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: string[];
  /** more rows GET /api/machines/ssh-candidates answers */
  let extraCandidates: object[];

  beforeEach(() => {
    requests = [];
    extraCandidates = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://workstation.example.ts.net/" },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    const fetch = async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net").pathname;
      requests.push(path);
      if (path === "/api/machines/ssh-candidates") return Response.json({ pcs: [
        { name: "nuc12", destination: "nuc12", detail: "rise@100.127.218.1", source: "ssh_config" },
        { name: "winvm", destination: "winvm.tail.ts.net", detail: "winvm.tail.ts.net", source: "tailscale", tailnet: "winvm.tail.ts.net" },
        ...extraCandidates,
      ] });
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = async (node: React.ReactNode) => { await act(async () => { renderer = create(<SettingsProvider>{node}</SettingsProvider>); }); };
  const qrCodes = () => renderer!.root.findAllByType(QrCode);
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const button = (label: string) => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === label);
    expect(found.map(text)).toEqual([label]);
    return found[0]!;
  };
  const buttons = () => renderer!.root.findAll((node) => node.type === "button").map((node) => text(node).trim());

  it("shows the Tailscale address with Copy address and no QR code until Show QR code", async () => {
    await mount(<PhonePanel url="https://workstation.example.ts.net" phone />);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toContain("Copy address");
    await act(async () => { button("Show QR code").props.onClick(); });
    expect(qrCodes()).toHaveLength(1);
  });

  it("keeps the desktop's Tailscale QR code up front", async () => {
    await mount(<PhonePanel url="https://workstation.example.ts.net" />);
    expect(qrCodes()).toHaveLength(1);
    expect(buttons()).not.toContain("Show QR code");
  });

  it("offers only the ways this window can use: SSH where PCs are added from", () => {
    expect(connectTabs({ sshOffered: true })).toEqual(["ssh", "devices"]);
    expect(connectTabs({ sshOffered: false })).toEqual(["devices"]);
  });

  it("lists the PCs found over SSH: Add opens Add PC with that address, an added one says so, a herdr PC connects", async () => {
    const added: (AddPcPreset | undefined)[] = [];
    const connected: string[] = [];
    const ssh = (destination: string, extra: Partial<Machine> = {}): Machine => ({ id: destination, name: destination, kind: "ssh", target: { destination }, enabled: true, state: "disconnected", error: null, snapshot: null, ...extra });
    const machines = [ssh("winvm.tail.ts.net", { state: "connected" }), ssh("build-box", { herdr_profile_id: "p1", action_required: "connect" })];
    await mount(<SshTab machines={machines} onAddPc={(preset) => { added.push(preset); }} onConnectMachine={(machine) => { connected.push(machine.id); }} />);
    expect(requests).toContain("/api/machines/ssh-candidates");
    expect(buttons()).toEqual(["Connect", "Add", "Add"]);
    expect(text(renderer!.root).includes("Added")).toBe(true);
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Add nuc12" }).props.onClick(); });
    expect(added).toEqual([{ destination: "nuc12", name: "nuc12" }]);
    await act(async () => { button("Connect").props.onClick(); });
    expect(connected).toEqual(["build-box"]);
  });

});
