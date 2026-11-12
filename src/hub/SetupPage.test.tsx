import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { SetupChoices, SetupStatus } from "../../shared/factory-setup.ts";
import { fixtureBootstrap, fixtureOverview } from "./fixtures.ts";
import { FactoryUnreachable, SetupApiError, type OwnerSetupApi } from "./ownerSetupApi.ts";
import { LinearCallback, SetupPage, type SetupDeps } from "./SetupPage.tsx";

// The components talk to stand-ins for the owner factory, GitHub, Linear and Claude, with made-up canaries.
const identity = fixtureBootstrap.me;
const renderers: ReactTestRenderer[] = [];
beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount()); });

const base: SetupStatus = { version: 1, github: { state: "not_connected" }, linear: { state: "not_connected" }, settings: null, claude: { state: "not_signed_in" }, ready: false, next: "github" };
const choices: SetupChoices = { repositories: [{ fullName: "example-org/widgets", private: true }, { fullName: "example-org/docs", private: false }], teams: [{ key: "ENG", name: "Engineering" }], proposed: { gitName: "Ada Example", gitEmail: "4242+ada-dev@users.noreply.github.com" } };
const connected = { state: "connected" as const, login: "ada-dev", noreplyEmail: "4242+ada-dev@users.noreply.github.com" };

function fakeOwner(state: { status: SetupStatus | Error }, overrides: Partial<OwnerSetupApi> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const record = <T,>(name: string, result: () => T | Promise<T>) => (...args: unknown[]): Promise<T> => { calls.push({ name, args }); try { return Promise.resolve(result()); } catch (error) { return Promise.reject(error); } };
  const api: OwnerSetupApi = {
    primeUrl: () => "https://ada.factory.example.com/api/factory/setup/prime?next=setup",
    status: record("status", () => { if (state.status instanceof Error) throw state.status; return state.status; }),
    choices: record("choices", () => choices),
    githubStart: record("githubStart", () => ({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" as const, expiresIn: 900, interval: 5 })),
    githubPoll: record("githubPoll", () => ({ state: "pending" as const, interval: 5 })),
    githubDisconnect: record("githubDisconnect", () => undefined),
    linearStart: record("linearStart", () => ({ url: "https://linear.app/oauth/authorize?client_id=c&state=s" })),
    linearCallback: record("linearCallback", () => ({ name: "Ada Example" })),
    linearDisconnect: record("linearDisconnect", () => undefined),
    saveSettings: record("saveSettings", () => { throw new Error("unexpected"); }),
    claudeStart: record("claudeStart", () => ({ login_id: "L1", device_auth: false })),
    claudePrompt: record("claudePrompt", () => ({ provider: "claude" as const, url: null, user_code: null, wants_code: false, ended: false })),
    claudeCode: record("claudeCode", () => undefined),
    claudeCancel: record("claudeCancel", () => undefined),
    ...overrides,
  };
  return { api, calls, count: (name: string) => calls.filter((call) => call.name === name).length };
}

function deps(owner: OwnerSetupApi, extra: Partial<SetupDeps> = {}) {
  const navigations: string[] = [];
  const value: SetupDeps = { overview: async () => fixtureOverview, hubSetup: async () => ({ invitation: null }), owner: () => owner, navigate: (url) => { navigations.push(url); }, wait: async () => {}, ...extra };
  return { value, navigations };
}

async function settle() { for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); }); }
async function mount(element: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(element); });
  renderers.push(renderer);
  await settle();
  return renderer;
}
// the visible text, with the pieces a template or an expression splits joined back together
const flat = (node: unknown): string => Array.isArray(node) ? node.map(flat).join("") : typeof node === "string" ? node : node && typeof node === "object" && "children" in node ? flat((node as { children: unknown }).children) : "";
const text = (renderer: ReactTestRenderer) => flat(renderer.toJSON());
const button = (renderer: ReactTestRenderer, label: string): ReactTestInstance => {
  const found = renderer.root.findAllByType("button").find((item) => flat(item.children.map((child) => typeof child === "string" ? child : child.props.children ?? "")).includes(label));
  if (!found) throw new Error(`no button "${label}" in ${text(renderer)}`);
  return found;
};
const click = async (renderer: ReactTestRenderer, label: string) => { await act(async () => { button(renderer, label).props.onClick({ preventDefault() {} }); }); await settle(); };

describe("Setup page", () => {
  it("explains a factory still being created without asking for anything", async () => {
    const owner = fakeOwner({ status: base });
    const setup = deps(owner.api, { overview: async () => ({ ...fixtureOverview, factories: [], live: [] }), hubSetup: async () => ({ invitation: { factory: "ada-factory", state: "creating", delivery: "waiting", progressAt: "2026-11-12T08:00:00Z" } }) });
    const view = await mount(<SetupPage identity={identity} deps={setup.value} />);
    expect(text(view)).toContain("is being created");
    expect(owner.calls).toEqual([]);
  });

  it("shows a failed creation and an administrator's next step, and says so when there is no factory at all", async () => {
    const failed = await mount(<SetupPage identity={identity} deps={deps(fakeOwner({ status: base }).api, { overview: async () => ({ ...fixtureOverview, factories: [], live: [] }), hubSetup: async () => ({ invitation: { factory: "ada-factory", state: "failed", delivery: "waiting", error: "The deployment failed." } }) }).value} />);
    expect(text(failed)).toContain("failed");
    expect(text(failed)).toContain("invite you again");
    const none = await mount(<SetupPage identity={identity} deps={deps(fakeOwner({ status: base }).api, { overview: async () => ({ ...fixtureOverview, factories: [], live: [] }) }).value} />);
    expect(text(none)).toContain("no factory yet");
  });

  it("asks the person to sign in to their factory host when it does not answer, and returns through the fixed prime address", async () => {
    const owner = fakeOwner({ status: new FactoryUnreachable() });
    const setup = deps(owner.api);
    const view = await mount(<SetupPage identity={identity} deps={setup.value} />);
    expect(text(view)).toContain("Sign in to your factory");
    await click(view, "Sign in to sample-factory");
    expect(setup.navigations).toEqual(["https://ada.factory.example.com/api/factory/setup/prime?next=setup"]);
  });

  it("never asks another person's factory: only the registered owner's origin is used", async () => {
    const origins: string[] = [];
    const owner = fakeOwner({ status: base });
    const other = { ...identity, person: "grace@example.com" };
    const setup = deps(owner.api, { owner: (origin) => { origins.push(origin); return owner.api; } });
    const view = await mount(<SetupPage identity={other} deps={setup.value} />);
    expect(origins).toEqual([]);
    expect(text(view)).toContain("no factory yet");
  });

  it("connects GitHub with a device code, follows the poll to the end and then reloads the status", async () => {
    const state = { status: base as SetupStatus | Error };
    let polls = 0;
    const owner = fakeOwner(state, { githubPoll: async () => { polls += 1; if (polls < 3) return { state: "pending", interval: 5 }; state.status = { ...base, github: connected, next: "linear" }; return { state: "connected", login: "ada-dev" }; } });
    const view = await mount(<SetupPage identity={identity} deps={deps(owner.api).value} />);
    expect(text(view)).toContain("Not connected.");
    await click(view, "Connect GitHub");
    expect(owner.count("githubStart")).toBe(1);
    expect(polls).toBe(3);
    expect(text(view)).toContain("Connected as ada-dev.");
    expect(text(view)).not.toContain("WDJB-MJHT");
  });

  it("shows the code and GitHub's own page while waiting, and a denial as a plain message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = fakeOwner({ status: base }, { githubPoll: async () => { await gate; return { state: "failed", reason: "denied", message: "GitHub sign-in was cancelled. Start again when you are ready." }; } });
    const view = await mount(<SetupPage identity={identity} deps={deps(owner.api).value} />);
    await click(view, "Connect GitHub");
    expect(text(view)).toContain("WDJB-MJHT");
    expect(view.root.findAllByType("a").some((a) => a.props.href === "https://github.com/login/device")).toBe(true);
    await act(async () => { release(); }); await settle();
    expect(text(view)).toContain("cancelled");
    expect(text(view)).not.toContain("WDJB-MJHT");
  });

  it("sends the person to Linear's own authorize page and shows a refusal from the factory", async () => {
    const owner = fakeOwner({ status: { ...base, github: connected, next: "linear" } });
    const setup = deps(owner.api);
    const view = await mount(<SetupPage identity={identity} deps={setup.value} />);
    await click(view, "Connect Linear");
    expect(setup.navigations).toEqual(["https://linear.app/oauth/authorize?client_id=c&state=s"]);
    const refused = fakeOwner({ status: { ...base, github: connected, next: "linear" } }, { linearStart: async () => { throw new SetupApiError(409, "linear_not_registered", "The organization has not registered its Linear app, or does not use Linear."); } });
    const again = await mount(<SetupPage identity={identity} deps={deps(refused.api).value} />);
    await click(again, "Connect Linear");
    expect(text(again)).toContain("has not registered its Linear app");
  });

  it("offers no Linear step when the organization does not use it", async () => {
    const owner = fakeOwner({ status: { ...base, github: connected, linear: { state: "not_used" }, next: "settings" } });
    const view = await mount(<SetupPage identity={identity} deps={deps(owner.api).value} />);
    expect(text(view)).not.toContain("Connect Linear");
  });

  it("reports an expired connection as expired, with a reconnect, and never as connected", async () => {
    const owner = fakeOwner({ status: { ...base, github: { state: "expired", login: "ada-dev", reason: "The GitHub connection has expired. Connect again." }, next: "github" } });
    const view = await mount(<SetupPage identity={identity} deps={deps(owner.api).value} />);
    expect(text(view)).toContain("Expired");
    expect(text(view)).toContain("Reconnect GitHub");
    expect(text(view)).not.toContain("Connected as");
  });

  it("saves the chosen repositories, team and git identity, prefilled from the connected account", async () => {
    const state = { status: { ...base, github: connected, linear: { state: "connected" as const, name: "Ada Example" }, next: "settings" as const } as SetupStatus | Error };
    const saved: unknown[] = [];
    const owner = fakeOwner(state, { saveSettings: async (settings) => { saved.push(settings); state.status = { ...(state.status as SetupStatus), settings, next: "claude" }; return settings; } });
    const view = await mount(<SetupPage identity={identity} deps={deps(owner.api).value} />);
    expect(owner.count("choices")).toBe(1);
    const boxes = view.root.findAllByProps({ type: "checkbox" });
    expect(boxes.length).toBe(2);
    expect(view.root.findAllByType("form").length).toBeGreaterThan(0);
    await act(async () => { boxes[0]!.props.onChange({ target: { checked: true } }); });
    await act(async () => { view.root.findByType("select").props.onChange({ target: { value: "ENG" } }); });
    await act(async () => { view.root.findAllByType("form")[0]!.props.onSubmit({ preventDefault() {} }); }); await settle();
    expect(saved).toEqual([{ repositories: ["example-org/widgets"], linearTeam: "ENG", gitName: "Ada Example", gitEmail: "4242+ada-dev@users.noreply.github.com" }]);
    expect(text(view)).toContain("Saved: 1 repository, team ENG.");
  });

  it("does not offer the Claude sign-in before the choices are saved", async () => {
    const owner = fakeOwner({ status: { ...base, github: connected, linear: { state: "connected", name: "Ada" }, next: "settings" } });
    const view = await mount(<SetupPage identity={identity} deps={deps(owner.api).value} />);
    expect(button(view, "Sign in to Claude").props.disabled).toBe(true);
    expect(text(view)).toContain("No agent starts until every step is done");
  });

  it("follows Claude's sign-in: a link on Claude's own host, a code box, and the code goes only to the factory", async () => {
    const CANARY = "claude-code-canary#state";
    const settings = { repositories: ["example-org/widgets"], linearTeam: "ENG", gitName: "Ada Example", gitEmail: "ada@example.com" };
    const state = { status: { ...base, github: connected, linear: { state: "connected" as const, name: "Ada" }, settings, next: "claude" as const } as SetupStatus | Error };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let prompts = 0;
    const owner = fakeOwner(state, {
      claudePrompt: async () => {
        prompts += 1;
        if (prompts < 2) return { provider: "claude", url: "https://claude.ai/oauth/authorize?x=1", user_code: null, wants_code: true, ended: false };
        await gate;
        state.status = { ...(state.status as SetupStatus), claude: { state: "signed_in" }, ready: true, next: null };
        return { provider: "claude", url: null, user_code: null, wants_code: false, ended: true, succeeded: true };
      },
    });
    const setup = deps(owner.api);
    const view = await mount(<SetupPage identity={identity} deps={setup.value} />);
    await click(view, "Sign in to Claude");
    expect(owner.calls.find((call) => call.name === "claudeStart")!.args).toEqual([false]);
    expect(view.root.findAllByType("a").some((a) => a.props.href === "https://claude.ai/oauth/authorize?x=1")).toBe(true);
    const input = view.root.findAllByType("input").find((i) => i.props.autoComplete === "off" && i.props.value === "")!;
    await act(async () => { input.props.onChange({ target: { value: CANARY } }); });
    await act(async () => { view.root.findAllByType("form").at(-1)!.props.onSubmit({ preventDefault() {} }); }); await settle();
    expect(owner.calls.find((call) => call.name === "claudeCode")!.args).toEqual(["L1", CANARY]);
    expect(text(view)).not.toContain(CANARY);
    expect(setup.navigations).toEqual([]);
    await act(async () => { release(); }); await settle();
    expect(text(view)).toContain("Your factory is ready");
    expect(text(view)).toContain("Signed in.");
  });

  it("refuses a sign-in link that is not Claude's own page, and shows a CLI that did not sign in", async () => {
    const settings = { repositories: ["example-org/widgets"], linearTeam: "ENG", gitName: "Ada", gitEmail: "ada@example.com" };
    const owner = fakeOwner({ status: { ...base, github: connected, linear: { state: "connected", name: "Ada" }, settings, next: "claude" } }, { claudePrompt: async () => ({ provider: "claude", url: "https://evil.example.com/oauth", user_code: null, wants_code: false, ended: false }) });
    const view = await mount(<SetupPage identity={identity} deps={deps(owner.api, { wait: async (_ms, signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())); } }).value} />);
    await click(view, "Sign in to Claude");
    expect(view.root.findAllByType("a").some((a) => String(a.props.href).includes("evil"))).toBe(false);
    const failing = fakeOwner({ status: { ...base, github: connected, linear: { state: "connected", name: "Ada" }, settings, next: "claude" } }, { claudePrompt: async () => ({ provider: "claude", url: null, user_code: null, wants_code: false, ended: true, succeeded: false }) });
    const second = await mount(<SetupPage identity={identity} deps={deps(failing.api).value} />);
    await click(second, "Sign in to Claude");
    expect(text(second)).toContain("did not finish");
  });

  it("is not ready until every part is, however the status is worded", async () => {
    const view = await mount(<SetupPage identity={identity} deps={deps(fakeOwner({ status: { ...base, github: connected, linear: { state: "connected", name: "Ada" }, settings: null, ready: false } }).api).value} />);
    expect(text(view)).not.toContain("Your factory is ready");
  });
});

describe("Linear callback page", () => {
  const search = "?code=linear-code-canary&state=state-1";
  it("removes the one-time code from the address, sends it only to the person's own factory and returns to Setup", async () => {
    const owner = fakeOwner({ status: base });
    const setup = deps(owner.api);
    let cleaned = 0;
    const view = await mount(<LinearCallback identity={identity} deps={setup.value} search={search} clean={() => { cleaned += 1; }} />);
    expect(cleaned).toBe(1);
    expect(owner.calls.find((call) => call.name === "linearCallback")!.args).toEqual(["linear-code-canary", "state-1"]);
    expect(setup.navigations).toEqual(["/setup"]);
    expect(text(view)).not.toContain("linear-code-canary");
    expect(text(view)).toContain("Linear connected as Ada Example");
  });

  it("uses the code once even when the page renders again", async () => {
    const owner = fakeOwner({ status: base });
    const setup = deps(owner.api);
    const view = await mount(<LinearCallback identity={identity} deps={setup.value} search={search} clean={() => {}} />);
    await act(async () => { view.update(<LinearCallback identity={identity} deps={setup.value} search="" clean={() => {}} />); }); await settle();
    expect(owner.count("linearCallback")).toBe(1);
  });

  it("asks nothing of the factory when Linear was refused or returned no code", async () => {
    for (const query of ["?error=access_denied&state=s", "?state=s", "", "?code=c"]) {
      const owner = fakeOwner({ status: base });
      const view = await mount(<LinearCallback identity={identity} deps={deps(owner.api).value} search={query} clean={() => {}} />);
      expect(owner.calls, query).toEqual([]);
      expect(text(view), query).toContain("Linear was not connected");
    }
  });

  it("shows a stale or unauthorized callback plainly and offers the way back", async () => {
    const stale = fakeOwner({ status: base }, { linearCallback: async () => { throw new SetupApiError(403, "stale_callback", "This Linear link expired or was not started here. Connect Linear again."); } });
    const view = await mount(<LinearCallback identity={identity} deps={deps(stale.api).value} search={search} clean={() => {}} />);
    expect(text(view)).toContain("expired or was not started here");
    expect(view.root.findAllByType("a").some((a) => a.props.href === "/setup")).toBe(true);
    const signedOut = fakeOwner({ status: base }, { linearCallback: async () => { throw new FactoryUnreachable(); } });
    expect(text(await mount(<LinearCallback identity={identity} deps={deps(signedOut.api).value} search={search} clean={() => {}} />))).toContain("sign in to your factory");
  });

  it("never posts the code when the person has no ready factory", async () => {
    const owner = fakeOwner({ status: base });
    const view = await mount(<LinearCallback identity={identity} deps={deps(owner.api, { overview: async () => ({ ...fixtureOverview, factories: [], live: [] }) }).value} search={search} clean={() => {}} />);
    expect(owner.calls).toEqual([]);
    expect(text(view)).toContain("not ready");
  });
});
