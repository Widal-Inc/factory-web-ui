import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AdminOnboarding } from "./AdminOnboarding.tsx";
import { HubError } from "./contract.ts";
import { fixtureBootstrap } from "./fixtures.ts";
import type { Invite, OnboardingApi, OnboardingStatus } from "./onboardingApi.ts";

// The hub is a stand-in with made-up organizations and people; nothing reaches GitHub, Linear or a real hub.
const admin = { ...fixtureBootstrap.me, person: "admin@example.com", role: "admin" as const };
const renderers: ReactTestRenderer[] = [];
beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount()); });

const email = { productionAccess: false, sendingEnabled: false, review: "Email production access is in review." };
const bare: OnboardingStatus = { version: 1, linearCallback: "https://hub.example.com/linear/callback", email };
const withGithub: OnboardingStatus = { ...bare, github: { id: 7, clientId: "Iv1.example", slug: "example-factory", organization: "example-org" } };
const complete: OnboardingStatus = { ...withGithub, linear: { clientId: "linear-client-example" }, usesLinear: true };
const invite = (over: Partial<Invite> = {}): Invite => ({ id: "i1", owner: "ada@example.com", factory: "ada-factory", link: "https://hub.example.com/join#one-time", createdAt: "2026-11-12T08:00:00Z", expiresAt: "2026-11-19T08:00:00Z", state: "ready", delivery: "manual", ...over });

function fakeHub(state: { status: OnboardingStatus; invites: Invite[]; installed?: boolean | null }, overrides: Partial<OnboardingApi> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec = <T,>(name: string, result: () => T | Promise<T>) => (...args: unknown[]): Promise<T> => { calls.push({ name, args }); try { return Promise.resolve(result()); } catch (error) { return Promise.reject(error); } };
  const api: OnboardingApi = {
    status: rec("status", () => state.status),
    manifest: rec("manifest", () => ({ action: "https://github.com/organizations/example-org/settings/apps/new?state=abc", manifest: { name: "example-org Factory" }, instructions: "Create it." })),
    installation: rec("installation", () => state.installed === null || state.installed === undefined ? null : { installed: state.installed }),
    linear: rec("linear", () => ({ clientId: "linear-client-example", callback: "https://hub.example.com/linear/callback" })),
    invites: rec("invites", () => state.invites),
    invite: rec("invite", () => ({ person: "ada@example.com", role: "engineer", invite: invite({ state: "creating", delivery: "waiting" }) })),
    createMine: rec("createMine", () => invite({ owner: "admin@example.com", factory: "admin-factory", state: "creating", delivery: "waiting" })),
    ...overrides,
  };
  return { api, calls, count: (name: string) => calls.filter((call) => call.name === name).length };
}

const flat = (node: unknown): string => Array.isArray(node) ? node.map(flat).join("") : typeof node === "string" ? node : node && typeof node === "object" && "children" in node ? flat((node as { children: unknown }).children) : "";
const text = (renderer: ReactTestRenderer) => flat(renderer.toJSON());
async function settle() { for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); }); }
async function mount(api: OnboardingApi, extra: { submitForm?: (form: { action: string; manifest: string }) => void; pollMs?: number } = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AdminOnboarding api={api} identity={admin} {...extra} />); });
  renderers.push(renderer);
  await settle();
  return renderer;
}
const button = (renderer: ReactTestRenderer, label: string): ReactTestInstance => {
  const found = renderer.root.findAllByType("button").find((item) => flat(item.children.map((child) => typeof child === "string" ? child : child.props.children ?? "")).includes(label));
  if (!found) throw new Error(`no button "${label}" in ${text(renderer)}`);
  return found;
};
const submit = async (renderer: ReactTestRenderer, index: number) => { await act(async () => { renderer.root.findAllByType("form")[index]!.props.onSubmit({ preventDefault() {} }); }); await settle(); };
const type = async (renderer: ReactTestRenderer, label: string, value: string) => {
  const field = renderer.root.findAllByType("label").find((item) => flat(item.children.map((child) => typeof child === "string" ? child : "")).includes(label))!.findByType(label === "Role" ? "select" : "input");
  await act(async () => { field.props.onChange({ target: { value } }); });
};

describe("Admin onboarding", () => {
  it("says what the hub reported, in order: GitHub App first, nothing invitable yet", async () => {
    const view = await mount(fakeHub({ status: bare, invites: [] }).api);
    expect(text(view)).toContain("1. GitHub App");
    expect(text(view)).toContain("Create the GitHub App");
    expect(text(view)).toContain("Create the GitHub App first.");
    expect(button(view, "Invite").props.disabled).toBe(true);
    expect(button(view, "Create my own factory").props.disabled).toBe(true);
    expect(text(view)).toContain("Email production access is in review.");
  });

  it("creates the GitHub App by posting the hub's manifest to GitHub, and shows a refusal from the hub", async () => {
    const forms: { action: string; manifest: string }[] = [];
    const hub = fakeHub({ status: bare, invites: [] });
    const view = await mount(hub.api, { submitForm: (form) => forms.push(form) });
    await type(view, "GitHub organization", "not valid!");
    await submit(view, 0);
    expect(text(view)).toContain("Enter the GitHub organization's name");
    expect(hub.count("manifest")).toBe(0);
    await type(view, "GitHub organization", "example-org");
    await submit(view, 0);
    expect(hub.calls.find((call) => call.name === "manifest")!.args).toEqual(["example-org"]);
    expect(forms).toEqual([{ action: "https://github.com/organizations/example-org/settings/apps/new?state=abc", manifest: "{\"name\":\"example-org Factory\"}" }]);
    const refused = fakeHub({ status: bare, invites: [] }, { manifest: async () => { throw new HubError(409, "The organization's GitHub App is already connected."); } });
    const second = await mount(refused.api, { submitForm: (form) => forms.push(form) });
    await type(second, "GitHub organization", "example-org");
    await submit(second, 0);
    expect(text(second)).toContain("already connected");
    expect(forms.length).toBe(1);
  });

  it("never posts a manifest to an address that is not GitHub's organization page", async () => {
    const forms: unknown[] = [];
    const hub = fakeHub({ status: bare, invites: [] }, { manifest: async () => ({ action: "https://evil.example.com/organizations/example-org/settings/apps/new?state=a", manifest: {}, instructions: "x" }) });
    const view = await mount(hub.api, { submitForm: (form) => forms.push(form) });
    await type(view, "GitHub organization", "example-org");
    await submit(view, 0);
    expect(forms).toEqual([]);
    expect(text(view)).toContain("unexpected GitHub address");
  });

  it("shows the connected app, whether it is installed, and the Device Flow reminder", async () => {
    const notInstalled = await mount(fakeHub({ status: withGithub, invites: [], installed: null }).api);
    expect(text(notInstalled)).toContain("The app is not installed yet.");
    expect(notInstalled.root.findAllByType("a").some((a) => a.props.href === "https://github.com/apps/example-factory/installations/new")).toBe(true);
    expect(text(notInstalled)).toContain("Device Flow");
    const installed = await mount(fakeHub({ status: withGithub, invites: [], installed: true }).api);
    expect(text(installed)).toContain("installed on the organization's repositories");
    const unknown = await mount(fakeHub({ status: withGithub, invites: [] }, { installation: async () => { throw new HubError(502, "x"); } }).api);
    expect(text(unknown)).toContain("could not check the installation");
  });

  it("registers the Linear client id without a secret, shows the callback to register, and can say the team does not use Linear", async () => {
    const hub = fakeHub({ status: withGithub, invites: [] });
    const view = await mount(hub.api);
    expect(text(view)).toContain("https://hub.example.com/linear/callback");
    expect(text(view)).toContain("Never enter its secret here");
    await type(view, "Client ID", "bad id!");
    await submit(view, 0);
    expect(text(view)).toContain("Enter the Linear app's client ID");
    expect(hub.count("linear")).toBe(0);
    await type(view, "Client ID", "linear-client-example");
    await submit(view, 0);
    expect(hub.calls.find((call) => call.name === "linear")!.args).toEqual([{ clientId: "linear-client-example" }]);
    await act(async () => { button(view, "My team does not use Linear").props.onClick(); }); await settle();
    expect(hub.calls.filter((call) => call.name === "linear").at(-1)!.args).toEqual([{ usesLinear: false }]);
  });

  it("invites an engineer only once GitHub and Linear (or no Linear) are done, and reports the deployment started", async () => {
    const hub = fakeHub({ status: complete, invites: [] });
    const view = await mount(hub.api);
    expect(button(view, "Invite").props.disabled).toBe(false);
    await type(view, "Email", "not an email");
    await submit(view, 1);
    expect(text(view)).toContain("Enter the person's email address.");
    expect(hub.count("invite")).toBe(0);
    await type(view, "Email", "ada@example.com");
    await submit(view, 1);
    expect(hub.calls.find((call) => call.name === "invite")!.args).toEqual([{ email: "ada@example.com", role: "engineer" }]);
    expect(text(view)).toContain("Deploying ada-factory for ada@example.com.");
    const noLinear = await mount(fakeHub({ status: { ...withGithub, usesLinear: false }, invites: [] }).api);
    expect(button(noLinear, "Invite").props.disabled).toBe(false);
  });

  it("says plainly that an admin or viewer invite makes no factory, and that the hub refused an incomplete setup", async () => {
    const hub = fakeHub({ status: complete, invites: [] }, { invite: async () => ({ person: "grace@example.com", role: "viewer", invite: null }) });
    const view = await mount(hub.api);
    await type(view, "Email", "grace@example.com");
    await type(view, "Role", "viewer");
    await submit(view, 1);
    expect(text(view)).toContain("No factory is made for this role.");
    const refused = fakeHub({ status: complete, invites: [] }, { invite: async () => { throw new HubError(409, "Create the organization's GitHub App before inviting people."); } });
    const second = await mount(refused.api);
    await type(second, "Email", "ada@example.com");
    await submit(second, 1);
    expect(text(second)).toContain("before inviting people");
  });

  it("creates the admin's own factory and shows its progress, a failure with its reason, and delivery by hand", async () => {
    const state = { status: complete, invites: [invite({ state: "creating", delivery: "waiting", progressAt: "2026-11-12T08:05:00Z" }), invite({ id: "i2", owner: "grace@example.com", factory: "grace-factory", state: "failed", delivery: "waiting", error: "The deployment failed at the network step." }), invite({ id: "i3", owner: "alan@example.com", factory: "alan-factory", state: "ready", delivery: "manual" })] };
    const hub = fakeHub(state);
    const view = await mount(hub.api);
    expect(text(view)).toContain("Deploying…");
    expect(text(view)).toContain("The deployment failed at the network step.");
    expect(text(view)).toContain("Copy the link and send it yourself");
    const inputs = view.root.findAllByType("input").filter((i) => i.props.readOnly);
    expect(inputs.map((i) => i.props.value)).toEqual(["https://hub.example.com/join#one-time"]);
    await act(async () => { button(view, "Create my own factory").props.onClick(); }); await settle();
    expect(hub.count("createMine")).toBe(1);
    expect(text(view)).toContain("Deploying admin-factory for admin@example.com.");
  });

  it("shows no link for an invite that is used, replaced or still deploying", async () => {
    const view = await mount(fakeHub({ status: complete, invites: [invite({ usedAt: "2026-11-12T09:00:00Z" }), invite({ id: "i4", owner: "b@example.com", replacedAt: "2026-11-12T09:00:00Z" }), invite({ id: "i5", owner: "c@example.com", state: "creating", delivery: "waiting" })] }).api);
    expect(view.root.findAllByType("input").filter((i) => i.props.readOnly)).toEqual([]);
    expect(text(view)).toContain("Ready, opened by the person");
  });

  it("follows a deployment until it is done and stops asking afterwards", async () => {
    const state = { status: complete, invites: [invite({ state: "creating", delivery: "waiting" })] };
    const hub = fakeHub(state);
    let tick!: () => void;
    const realSetInterval = globalThis.setInterval;
    (globalThis as { setInterval: unknown }).setInterval = ((fn: () => void) => { tick = fn; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval;
    try {
      const view = await mount(hub.api, { pollMs: 1 });
      const before = hub.count("invites");
      state.invites = [invite({ state: "ready", delivery: "sent" })];
      await act(async () => { tick(); }); await settle();
      expect(hub.count("invites")).toBe(before + 1);
      expect(text(view)).toContain("Ready message emailed");
      expect(text(view)).not.toContain("Deploying…");
    } finally { (globalThis as { setInterval: unknown }).setInterval = realSetInterval; }
  });

  it("shows an unavailable hub as unavailable, with a way to retry, never as an empty setup", async () => {
    const view = await mount(fakeHub({ status: complete, invites: [] }, { status: async () => { throw new HubError(503, "Browser onboarding is not configured on this hub."); } }).api);
    expect(text(view)).toContain("not configured on this hub");
    expect(text(view)).not.toContain("1. GitHub App");
    expect(button(view, "Try again")).toBeDefined();
    const noList = await mount(fakeHub({ status: complete, invites: [] }, { invites: async () => { throw new HubError(502, "x"); } }).api);
    expect(text(noList)).toContain("1. GitHub App");
    expect(text(noList)).not.toContain("No invites yet.");
  });

  it("never asks for or shows a personal credential", async () => {
    const view = await mount(fakeHub({ status: complete, invites: [invite()] }).api);
    for (const word of ["password", "personal access token", "API key", "Claude code"]) expect(text(view).toLowerCase()).not.toContain(word.toLowerCase());
    expect(view.root.findAllByType("input").some((i) => i.props.type === "password")).toBe(false);
  });
});
