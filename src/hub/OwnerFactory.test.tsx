import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { getTransport, nativeTransport, setTransport } from "../lib/transport.ts";

// the fork's App is not what this checks: a stub stands in for the lazily loaded view
mock.module("./FactoryApp.tsx", () => ({ default: () => <p>live view</p> }));
const { OwnerFactory } = await import("./OwnerFactory.tsx");

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const renderers: ReactTestRenderer[] = [];
beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
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
  return { text, open };
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
});
