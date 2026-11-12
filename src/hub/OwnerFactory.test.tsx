import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { getTransport, nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

// the fork's App is not what this checks: a stub stands in for the lazily loaded view. Like the real
// App it may still reach its server while it is being torn down, so it records the transport it sees then.
const seenOnTeardown: Transport[] = [];
mock.module("./FactoryApp.tsx", () => ({ default: () => { useEffect(() => () => { seenOnTeardown.push(getTransport()); }, []); return <p>live view</p>; } }));
const { OwnerFactory } = await import("./OwnerFactory.tsx");

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const renderers: ReactTestRenderer[] = [];
beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  seenOnTeardown.length = 0;
  setTransport(nativeTransport);
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
function mount(origin: string) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://hub.example.com", pathname: "/my-factory" } } });
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<OwnerFactory factory="sample-factory" origin={origin} />); });
  renderers.push(renderer);
  const text = () => JSON.stringify(renderer.toJSON());
  const open = async () => { await act(async () => { renderer.root.findByType("button").props.onClick(); }); };
  // the transport is given back a microtask after the unmount, so wait for it like a page would
  const unmount = async () => { renderers.splice(renderers.indexOf(renderer), 1); await act(async () => { renderer.unmount(); }); };
  return { text, open, unmount };
}

describe("owner factory view", () => {
  it("connects to nothing until the person opens it", () => {
    const view = mount("https://ada.factory.example.com");
    expect(view.text()).toContain("Open sample-factory");
    expect(getTransport()).toBe(nativeTransport);
  });

  it("routes the App through the verified owner origin once opened", async () => {
    const view = mount("https://ada.factory.example.com");
    await view.open();
    expect(getTransport().kind).toBe("custom");
    expect(getTransport().resourceUrl("/api/health")).toBe("https://ada.factory.example.com/api/health");
    expect(view.text()).toContain("live view");
  });

  it("refuses an origin that is not a registered HTTPS origin and keeps the browser's own transport", async () => {
    const view = mount("http://ada.factory.example.com");
    await view.open();
    expect(view.text()).toContain("registered HTTPS origin");
    expect(getTransport()).toBe(nativeTransport);
  });

  it("holds one live view per page", async () => {
    const first = mount("https://ada.factory.example.com");
    await first.open();
    const second = mount("https://bob.factory.example.com");
    await second.open();
    expect(second.text()).toContain("already open");
    expect(getTransport().resourceUrl("/api/health")).toBe("https://ada.factory.example.com/api/health");
  });

  it("gives the transport back when the view unmounts, so a refresh can open the factory again", async () => {
    const first = mount("https://ada.factory.example.com");
    await first.open();
    const owner = getTransport();
    await first.unmount();
    // the App's own teardown still ran against the owner's transport, not the browser's
    expect(seenOnTeardown).toEqual([owner]);
    expect(getTransport()).toBe(nativeTransport);
    const second = mount("https://ada.factory.example.com");
    await second.open();
    expect(second.text()).toContain("live view");
    expect(second.text()).not.toContain("already open");
    expect(getTransport().resourceUrl("/api/health")).toBe("https://ada.factory.example.com/api/health");
  });

  it("never gives back a transport that a later view installed", async () => {
    const first = mount("https://ada.factory.example.com");
    await first.open();
    const stale = getTransport();
    // another owner of the page takes over the process-wide transport before the first view's release runs
    setTransport(nativeTransport);
    const second = mount("https://ada.factory.example.com");
    await second.open();
    const live = getTransport();
    expect(live).not.toBe(stale);
    await first.unmount();
    expect(getTransport()).toBe(live);
  });

  it("gives nothing back for a view that never opened", async () => {
    const view = mount("https://ada.factory.example.com");
    const other = directTransportStub();
    setTransport(other);
    await view.unmount();
    expect(getTransport()).toBe(other);
  });
});

function directTransportStub(): Transport {
  return { ...nativeTransport, kind: "custom", resourceUrl: (path) => `https://other.example.com${path}` };
}
