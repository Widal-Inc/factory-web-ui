import { afterEach, beforeAll, expect, it } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { HubApp, type HubSlots } from "./HubApp.tsx";
import { fixtureBootstrap, fixtureOverview } from "./fixtures.ts";

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const savedFetch = globalThis.fetch;
let renderer: ReactTestRenderer | undefined;
beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  globalThis.fetch = savedFetch;
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

async function open(search: string, overview = fixtureOverview, bootstrap = fixtureBootstrap, status = 200) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: "/my-factory", search } } });
  const reads: string[] = [];
  const opened: unknown[] = [];
  globalThis.fetch = (async (path: string) => {
    reads.push(path);
    if (path === "/api/app/bootstrap") return Response.json(bootstrap, { status });
    if (path === "/api/app/my/overview") return Response.json(overview);
    throw new Error("unexpected endpoint");
  }) as typeof fetch;
  const slots: HubSlots = { brand: { name: "Example app", logo: "/example.svg" }, ownerView: (connection) => { opened.push(connection); return <p>Owner document</p>; } };
  await act(async () => { renderer = create(<HubApp {...slots} />); });
  return { opened, reads, text: JSON.stringify(renderer?.toJSON()) };
}

it("restores a document tab from fresh signed identity and matching owner registration", async () => {
  const result = await open("?read=%2Frepo%2Fa.md&machine=remote-1&factory=sample-factory&origin=https%3A%2F%2Fevil.example.com");
  expect(result.reads).toEqual(["/api/app/bootstrap", "/api/app/my/overview"]);
  expect(result.opened).toEqual([{ factory: "sample-factory", origin: "https://ada.factory.example.com", reader: { machine: "remote-1", path: "/repo/a.md" } }]);
  expect(result.text).toContain("Owner document");
  expect(result.text).not.toContain("Subscription usage unavailable");
});

it("does not guess a factory or accept another person's registration, even for an admin", async () => {
  for (const search of ["?read=%2Fa.md", "?read=%2Fa.md&factory=missing"]) {
    const result = await open(search);
    expect(result.opened).toEqual([]);
    expect(result.text).toContain("Document unavailable");
    act(() => renderer?.unmount());
  }
  const result = await open("?read=%2Fa.md&factory=sample-factory", fixtureOverview, { ...fixtureBootstrap, me: { ...fixtureBootstrap.me, person: "admin@example.com", role: "admin" } });
  expect(result.opened).toEqual([]);
  expect(result.text).toContain("Document unavailable");
});

it("refuses a document when the live address differs from its registered factory", async () => {
  const result = await open("?read=%2Fa.md&factory=sample-factory", { ...fixtureOverview, live: [{ factory: "sample-factory", connection: { state: "direct", origin: "https://evil.example.com" } }] });
  expect(result.opened).toEqual([]);
  expect(result.text).toContain("Document unavailable");
});

it("makes no owner connection after expired sign-in or revoked hub access", async () => {
  for (const status of [401, 403]) {
    const result = await open("?read=%2Fa.md&factory=sample-factory", fixtureOverview, fixtureBootstrap, status);
    expect(result.reads).toEqual(["/api/app/bootstrap"]);
    expect(result.opened).toEqual([]);
    expect(result.text).toContain(status === 401 ? "Sign in again" : "Document unavailable");
    act(() => renderer?.unmount());
  }
});
