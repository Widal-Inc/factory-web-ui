import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { HubApp } from "./HubApp.tsx";
import { fixtureBootstrap, fixtureOverview } from "./fixtures.ts";

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let renderer: ReactTestRenderer | undefined;
beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  mock.restore();
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
function mount(path = "/my-factory") {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: path } } });
  const requests: { path: string; signal: AbortSignal; answer: (response: Response) => void }[] = [];
  const request = (path: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => { requests.push({ path: String(path), signal: init!.signal!, answer: resolve }); });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(request, { preconnect: fetch.preconnect }));
  act(() => { renderer = create(<HubApp brand={{ name: "Example app", logo: "/example.svg" }} />); });
  return {
    requests,
    text: () => JSON.stringify(renderer!.toJSON()),
    answer: async (index: number, body: unknown, status = 200) => { await act(async () => { requests[index]!.answer(Response.json(body, { status })); }); },
    refresh: () => act(() => { renderer!.root.findAllByType("button").find((b) => b.children.includes("Refresh page data"))!.props.onClick(); }),
  };
}
describe("hub page lifecycle", () => {
  it("loads identity before data, and removes personal content on a revoked refresh", async () => {
    const page = mount();
    expect(page.text()).toContain("Loading your factory");
    expect(page.requests.map((r) => r.path)).toEqual(["/api/app/bootstrap"]);
    await page.answer(0, fixtureBootstrap);
    expect(page.requests[1]!.path).toBe("/api/app/my/overview");
    await page.answer(1, fixtureOverview);
    expect(page.text()).toContain("Review the example change");
    page.refresh();
    expect(page.text()).not.toContain("Review the example change");
    expect(page.requests[0]!.signal.aborted).toBe(true);
    await page.answer(2, { error: "removed" }, 403);
    expect(page.text()).toContain("Access unavailable");
    expect(page.text()).not.toContain("ada@example.com");
    expect(page.requests).toHaveLength(3);
  });
  it("does not fetch Admin data for a non-admin deep link", async () => {
    const page = mount("/admin");
    await page.answer(0, fixtureBootstrap);
    expect(page.requests).toHaveLength(1);
    expect(page.text()).toContain("You do not have access to Admin");
  });
  it("aborts on unmount and ignores a response that arrives afterwards", async () => {
    const page = mount();
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(page.requests[0]!.signal.aborted).toBe(true);
    await page.answer(0, fixtureBootstrap);
    expect(page.requests).toHaveLength(1);
  });
  it("renders an API failure as failure, without an empty queue", async () => {
    const page = mount();
    await page.answer(0, fixtureBootstrap);
    await page.answer(1, { error: "database credentials must stay private" }, 503);
    expect(page.text()).toContain("Could not load the app");
    expect(page.text()).not.toContain("No open work items");
    expect(page.text()).not.toContain("database credentials");
  });
});
