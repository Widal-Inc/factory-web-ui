import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { GithubDeviceStart, SetupChoices, SetupStatus } from "../../shared/factory-setup.ts";
import type { UsageLoginPrompt } from "../../shared/usage-login.ts";
import { HubError, ownerOrigin, parseOverview, readHub, type Bootstrap, type Overview, type Parser } from "./contract.ts";
import { claudeSignInLink, FactoryUnreachable, type OwnerSetupApi } from "./ownerSetupApi.ts";

/** What the hub says about this person's invitation: progress and errors only, never a code or a link. */
export interface HubInvitation { readonly factory: string; readonly state: string; readonly delivery: string; readonly progressAt?: string; readonly error?: string }
export interface HubSetup { readonly invitation: HubInvitation | null }

export const parseHubSetup: Parser<HubSetup> = (value) => {
  const body = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!body || body["version"] !== 1) throw new Error("unsupported");
  const raw = body["invitation"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { invitation: null };
  const invitation = raw as Record<string, unknown>;
  const field = (name: string) => typeof invitation[name] === "string" ? invitation[name] as string : undefined;
  const factory = field("factory");
  const state = field("state");
  if (!factory || !state) return { invitation: null };
  return { invitation: { factory, state, delivery: field("delivery") ?? "waiting", ...(field("progressAt") ? { progressAt: field("progressAt")! } : {}), ...(field("error") ? { error: field("error")! } : {}) } };
};

export interface SetupDeps {
  readonly overview: (signal: AbortSignal) => Promise<Overview>;
  readonly hubSetup: (signal: AbortSignal) => Promise<HubSetup>;
  readonly owner: (origin: string) => OwnerSetupApi;
  /** A top-level navigation: how the person goes to GitHub's, Linear's or the factory host's own page. */
  readonly navigate: (url: string) => void;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done);
  });
}

export function browserSetupDeps(owner: (origin: string) => OwnerSetupApi): SetupDeps {
  return {
    overview: (signal) => readHub("/api/app/my/overview", parseOverview, signal),
    hubSetup: (signal) => readHub("/api/app/setup", parseHubSetup, signal),
    owner, navigate: (url) => window.location.assign(url), wait: waitFor,
  };
}

const text = (error: unknown): string => error instanceof Error ? error.message : "That did not work. Try again.";
function Step({ n, title, state, children }: { n: number; title: string; state: string; children: ReactNode }) {
  return <section className="hub-panel" aria-labelledby={`setup-step-${n}`}><h2 id={`setup-step-${n}`}>{n}. {title}</h2><p className="hub-state">{state}</p>{children}</section>;
}
const Problem = ({ children }: { children: ReactNode }) => <p role="alert" className="hub-problem">{children}</p>;

/** The signed-in person's Setup: they connect their own accounts on their own registered factory. */
export function SetupPage({ identity, deps }: { identity: Bootstrap["me"]; deps: SetupDeps }) {
  const [load, setLoad] = useState<{ state: "loading" } | { state: "error"; message: string } | { state: "ready"; overview: Overview; hub: HubSetup | null }>({ state: "loading" });
  const [attempt, again] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    void (async () => {
      try {
        const [overview, hub] = await Promise.all([deps.overview(controller.signal), deps.hubSetup(controller.signal).catch(() => null)]);
        if (!controller.signal.aborted) setLoad({ state: "ready", overview, hub });
      } catch (error) { if (!controller.signal.aborted) setLoad({ state: "error", message: error instanceof HubError ? error.message : "Setup could not be loaded. Try again." }); }
    })();
    return () => controller.abort();
  }, [deps, attempt]);
  // The owner client is made once per origin: a new one on every render would restart the status read.
  const mine = load.state === "ready" ? load.overview.factories.filter((f) => f.owner.trim().toLowerCase() === identity.person.trim().toLowerCase()) : [];
  const ready = load.state === "ready" ? mine.find((f) => f.state === "ready" && ownerOrigin(load.overview, identity.person, f.factory) !== null) : undefined;
  const origin = load.state === "ready" && ready ? ownerOrigin(load.overview, identity.person, ready.factory) : null;
  const api = useMemo(() => {
    // an origin the transport refuses leaves the person with the "no usable address" message, not a blank page
    try { return origin ? deps.owner(origin) : null; } catch { return null; }
  }, [deps, origin]);
  if (load.state === "loading") return <p role="status">Loading Setup…</p>;
  if (load.state === "error") return <section role="alert"><p>{load.message}</p><button type="button" className="btn" onClick={() => again((n) => n + 1)}>Try again</button></section>;
  if (ready && api) return <OwnerSetup factory={ready.factory} api={api} deps={deps} />;
  return <NoFactory invitation={load.hub?.invitation ?? null} known={mine.length > 0} reload={() => again((n) => n + 1)} />;
}

function NoFactory({ invitation, known, reload }: { invitation: HubInvitation | null; known: boolean; reload: () => void }) {
  return <section className="hub-notice"><h2>Your factory is not ready yet</h2>
    {invitation?.state === "creating" ? <p role="status">Your factory <strong>{invitation.factory}</strong> is being created. This takes a few minutes.{invitation.progressAt && ` Last progress ${new Date(invitation.progressAt).toLocaleTimeString()}.`}</p>
      : invitation?.state === "failed" ? <p role="alert">Creating <strong>{invitation.factory}</strong> failed.{invitation.error ? ` ${invitation.error}` : ""} Ask your administrator to invite you again.</p>
        : known ? <p>Your factory is registered, but it has no address the app can use yet. Ask your administrator.</p>
          : <p>You have no factory yet. Open the invitation your administrator sent, or ask them to invite you. Nothing has been asked of you and nothing is saved.</p>}
    <button type="button" className="btn" onClick={reload}>Check again</button></section>;
}

function OwnerSetup({ factory, api, deps }: { factory: string; api: OwnerSetupApi; deps: SetupDeps }) {
  const [status, setStatus] = useState<{ state: "loading" } | { state: "signin" } | { state: "error"; message: string } | { state: "ready"; value: SetupStatus }>({ state: "loading" });
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await api.status(signal);
      if (!signal?.aborted) setStatus({ state: "ready", value });
    } catch (error) {
      if (signal?.aborted) return;
      setStatus(error instanceof FactoryUnreachable ? { state: "signin" } : { state: "error", message: text(error) });
    }
  }, [api]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  if (status.state === "loading") return <p role="status">Checking your factory…</p>;
  if (status.state === "signin") return <section className="hub-notice"><h2>Sign in to your factory</h2><p>Your factory did not answer with your sign-in. Open it once to sign in, then you come straight back here.</p>
    <p><button type="button" className="btn" onClick={() => deps.navigate(api.primeUrl("setup"))}>Sign in to {factory}</button> <button type="button" className="btn" onClick={() => { setStatus({ state: "loading" }); void refresh(); }}>Try again</button></p></section>;
  if (status.state === "error") return <section role="alert"><p>{status.message}</p><button type="button" className="btn" onClick={() => { setStatus({ state: "loading" }); void refresh(); }}>Try again</button></section>;
  const value = status.value;
  const reload = () => refresh();
  return <div className="hub-setup"><p>Connect your own accounts on <strong>{factory}</strong>. Your GitHub, Linear and Claude credentials are kept on your factory: they never go to the hub or to your team's agents' settings, and the app never shows them.</p>
    {value.ready && <section className="hub-notice" role="status"><h2>Setup is complete</h2><p>GitHub{value.linear.state === "not_used" ? "" : ", Linear"}, your choices and Claude are all connected on your factory. This page starts no agent.</p><p><a className="btn" href="/my-factory">Go to My Factory</a></p></section>}
    <GithubStep value={value} api={api} deps={deps} onChange={reload} />
    {value.linear.state !== "not_used" && <LinearStep value={value} api={api} deps={deps} onChange={reload} />}
    <ChoicesStep value={value} api={api} onChange={reload} />
    <ClaudeStep value={value} api={api} deps={deps} onChange={reload} />
  </div>;
}

function GithubStep({ value, api, deps, onChange }: { value: SetupStatus; api: OwnerSetupApi; deps: SetupDeps; onChange: () => Promise<void> }) {
  const [device, setDevice] = useState<GithubDeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);
  async function connect() {
    setBusy(true); setError(null);
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    try {
      const start = await api.githubStart();
      setDevice(start);
      let interval = start.interval;
      while (!controller.signal.aborted) {
        await deps.wait(interval * 1000, controller.signal);
        if (controller.signal.aborted) return;
        const poll = await api.githubPoll(controller.signal);
        if (poll.state === "pending") { interval = poll.interval; continue; }
        setDevice(null);
        if (poll.state === "failed") setError(poll.message);
        else await onChange();
        break;
      }
    } catch (cause) { if (!controller.signal.aborted) { setDevice(null); setError(text(cause)); } } finally { if (run.current === controller) setBusy(false); }
  }
  const github = value.github;
  const label = github.state === "connected" ? `Connected as ${github.login}.` : github.state === "expired" ? `Expired${github.login ? ` (${github.login})` : ""}. Connect again.` : github.state === "unavailable" ? `Unavailable. ${github.reason ?? ""}` : "Not connected.";
  return <Step n={1} title="Connect GitHub" state={label}>
    {device ? <div role="status"><p>Open <a href={device.verificationUri} target="_blank" rel="noreferrer">GitHub's device page</a> and enter this code:</p><p className="hub-code" aria-label="GitHub code">{device.userCode}</p><p className="hub-muted">Waiting for you to approve it on GitHub. The code expires in {Math.round(device.expiresIn / 60)} minutes.</p>
      <button type="button" className="btn" onClick={() => { run.current?.abort(); setDevice(null); setBusy(false); }}>Cancel</button></div>
      : <p><button type="button" className="btn" disabled={busy || github.state === "unavailable"} onClick={() => void connect()}>{github.state === "connected" ? "Connect a different GitHub account" : github.state === "expired" ? "Reconnect GitHub" : "Connect GitHub"}</button>{github.state === "connected" && <> <button type="button" className="btn" onClick={() => void api.githubDisconnect().then(onChange, (cause) => setError(text(cause)))}>Disconnect</button></>}</p>}
    {github.state === "connected" && <p className="hub-muted">Your agents will open pull requests as {github.login}.</p>}
    {github.state === "connected" && github.expiresAt !== undefined && <p className="hub-muted">GitHub ends this connection at {new Date(github.expiresAt).toLocaleString()}. From then on your agents cannot use GitHub and do not start until you connect GitHub again here.</p>}
    {github.state === "expired" && <p className="hub-muted">Your agents cannot use GitHub and do not start until you connect GitHub again.</p>}
    {error && <Problem>{error}</Problem>}</Step>;
}

function LinearStep({ value, api, deps, onChange }: { value: SetupStatus; api: OwnerSetupApi; deps: SetupDeps; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linear = value.linear;
  async function connect() {
    setBusy(true); setError(null);
    try { deps.navigate((await api.linearStart()).url); } catch (cause) { setError(text(cause)); setBusy(false); }
  }
  const label = linear.state === "connected" ? `Connected as ${linear.name}.` : linear.state === "expired" ? `Expired${linear.name ? ` (${linear.name})` : ""}. Connect again.` : linear.state === "unavailable" ? `Unavailable. ${linear.reason ?? ""}` : "Not connected.";
  const blocked = value.github.state !== "connected";
  return <Step n={2} title="Connect Linear" state={label}>
    <p><button type="button" className="btn" disabled={busy || blocked || linear.state === "unavailable"} onClick={() => void connect()}>{linear.state === "connected" ? "Connect again" : linear.state === "expired" ? "Reconnect Linear" : "Connect Linear"}</button>{linear.state === "connected" && <> <button type="button" className="btn" onClick={() => void api.linearDisconnect().then(onChange, (cause) => setError(text(cause)))}>Disconnect</button></>}</p>
    <p className="hub-muted">{blocked ? "Connect GitHub first. " : ""}You go to Linear to approve, then come back here.</p>{error && <Problem>{error}</Problem>}</Step>;
}

function ChoicesStep({ value, api, onChange }: { value: SetupStatus; api: OwnerSetupApi; onChange: () => Promise<void> }) {
  const needed = value.github.state === "connected" && (value.linear.state === "connected" || value.linear.state === "not_used");
  const [choices, setChoices] = useState<{ state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: SetupChoices }>({ state: "idle" });
  const [repositories, setRepositories] = useState<string[]>([...(value.settings?.repositories ?? [])]);
  const [team, setTeam] = useState(value.settings?.linearTeam ?? "");
  const [gitName, setGitName] = useState(value.settings?.gitName ?? "");
  const [gitEmail, setGitEmail] = useState(value.settings?.gitEmail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // The selections belong to the accounts they were made with; another account starts from its own saved choices.
  const account = `${value.github.login ?? ""}\n${value.linear.name ?? ""}`;
  const selectedFor = useRef(account);
  const settings = value.settings;
  useEffect(() => {
    if (!needed) { setChoices({ state: "idle" }); return undefined; }
    const controller = new AbortController();
    setChoices({ state: "loading" });
    api.choices(controller.signal).then((found) => {
      if (controller.signal.aborted) return;
      setChoices({ state: "ready", value: found });
      // A repository the account can no longer reach has no checkbox, so it is never kept selected or sent.
      const reachable = new Set(found.repositories.map((repo) => repo.fullName));
      const onlyTeam = found.teams.length === 1 ? found.teams[0]!.key : "";
      // likewise a team that no longer exists is not kept selected
      const teamOr = (key: string | null | undefined) => key && found.teams.some((t) => t.key === key) ? key : onlyTeam;
      if (selectedFor.current !== account) {
        selectedFor.current = account;
        setRepositories((settings?.repositories ?? []).filter((name) => reachable.has(name)));
        setGitName(settings?.gitName || found.proposed.gitName);
        setGitEmail(settings?.gitEmail || found.proposed.gitEmail);
        setTeam(teamOr(settings?.linearTeam));
        return;
      }
      setRepositories((current) => current.filter((name) => reachable.has(name)));
      setGitName((current) => current || found.proposed.gitName);
      setGitEmail((current) => current || found.proposed.gitEmail);
      setTeam(teamOr);
    }, (cause) => { if (!controller.signal.aborted) setChoices({ state: "error", message: text(cause) }); });
    return () => controller.abort();
  }, [api, needed, account]); // eslint-disable-line react-hooks/exhaustive-deps -- settings is read only when the account changes
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null); setSaved(false);
    // the accounts this page shows: if another tab connected a different one meanwhile, the factory refuses the save
    // (a connected GitHub always has its id; -1 is never one, so a status without it cannot save over anything)
    const accounts = { github: value.github.id ?? -1, linear: value.linear.state === "not_used" ? null : value.linear.id ?? null };
    try { await api.saveSettings({ repositories, linearTeam: value.linear.state === "not_used" ? null : team || null, gitName: gitName.trim(), gitEmail: gitEmail.trim(), accounts }); setSaved(true); await onChange(); } catch (cause) { setError(text(cause)); } finally { setBusy(false); }
  }
  const lost = value.unreachableRepositories;
  const label = value.settings && lost.length > 0 ? "Saved, but no longer usable: choose again and save."
    : value.settings ? `Saved: ${value.settings.repositories.length} repositor${value.settings.repositories.length === 1 ? "y" : "ies"}${value.settings.linearTeam ? `, team ${value.settings.linearTeam}` : ""}.` : needed ? "Not saved yet." : "Connect your accounts first.";
  return <Step n={value.linear.state === "not_used" ? 2 : 3} title="Choose repositories, team and git identity" state={label}>
    {value.settings && lost.length > 0 && <Problem>The organization's GitHub App no longer reaches {lost.length === 1 ? "this saved repository" : "these saved repositories"}: {lost.join(", ")}. Your agents do not start until you save your choices again, or an administrator gives the app access again.</Problem>}
    {choices.state === "loading" && <p role="status">Loading what you can choose…</p>}{choices.state === "error" && <Problem>{choices.message}</Problem>}
    {choices.state === "ready" && <form onSubmit={(event) => void save(event)}>
      <fieldset><legend>Repositories your agents may work in</legend>{choices.value.repositories.length === 0 ? <p>The organization's GitHub App reaches no repositories for you. Ask an administrator to install it on them.</p> : choices.value.repositories.map((repo) => <label key={repo.fullName} className="hub-check"><input type="checkbox" checked={repositories.includes(repo.fullName)} onChange={(event) => setRepositories((current) => event.target.checked ? [...current, repo.fullName] : current.filter((name) => name !== repo.fullName))} /> {repo.fullName}{repo.private ? " (private)" : ""}</label>)}</fieldset>
      {value.linear.state !== "not_used" && <p><label>Linear team <select value={team} onChange={(event) => setTeam(event.target.value)}><option value="">Choose a team</option>{choices.value.teams.map((t) => <option key={t.key} value={t.key}>{t.name} ({t.key})</option>)}</select></label></p>}
      <p><label>Name your agents commit with <input value={gitName} onChange={(event) => setGitName(event.target.value)} autoComplete="off" /></label></p>
      <p><label>Email your agents commit with <input type="email" value={gitEmail} onChange={(event) => setGitEmail(event.target.value)} autoComplete="off" /></label></p>
      <button className="btn" type="submit" disabled={busy || repositories.length === 0}>{value.settings ? "Update choices" : "Save choices"}</button></form>}
    {saved && <p role="status">Saved.</p>}{error && <Problem>{error}</Problem>}</Step>;
}

function ClaudeStep({ value, api, deps, onChange }: { value: SetupStatus; api: OwnerSetupApi; deps: SetupDeps; onChange: () => Promise<void> }) {
  const [login, setLogin] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<UsageLoginPrompt | null>(null);
  // The pasted code is a secret: it lives in the input element only (uncontrolled), is read once on submit and
  // cleared at once, and is never in React state, a draft, a queue or a retry.
  const codeInput = useRef<HTMLInputElement>(null);
  const clearCode = () => { if (codeInput.current) codeInput.current.value = ""; };
  const [error, setError] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);
  const active = useRef<string | null>(null);
  useEffect(() => () => { run.current?.abort(); if (active.current) void api.claudeCancel(active.current).catch(() => {}); }, [api]);
  const prerequisites = value.settings !== null;
  async function start(replace: boolean) {
    setError(null); clearCode(); setPrompt(null);
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    try {
      const started = await api.claudeStart(replace);
      active.current = started.login_id;
      setLogin(started.login_id);
      while (!controller.signal.aborted) {
        const current = await api.claudePrompt(started.login_id, controller.signal);
        if (controller.signal.aborted) return;
        setPrompt(current);
        if (current.ended) {
          active.current = null; clearCode(); setLogin(null);
          if (current.succeeded === false) setError("The Claude sign-in did not finish. Start it again.");
          await onChange();
          return;
        }
        await deps.wait(2000, controller.signal);
      }
    } catch (cause) { if (!controller.signal.aborted) { active.current = null; clearCode(); setLogin(null); setError(text(cause)); } }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const typed = codeInput.current?.value.trim() ?? "";
    clearCode();
    if (!login || !typed) return;
    // sent once; a failure shows a message and the person pastes the code again: it is never kept to retry
    try { await api.claudeCode(login, typed); } catch (cause) { setError(text(cause)); }
  }
  const signedIn = value.claude.state === "signed_in";
  const link = claudeSignInLink(prompt?.url ?? null);
  const label = signedIn ? "Signed in." : value.claude.state === "unavailable" ? "This factory cannot say whether Claude is signed in." : "Not signed in.";
  return <Step n={value.linear.state === "not_used" ? 3 : 4} title="Sign in to Claude" state={label}>
    {login ? <div role="status"><p>{link ? <>Open <a href={link} target="_blank" rel="noreferrer">Claude's sign-in page</a>, approve, then paste the code it shows here.</> : "Waiting for the sign-in page address…"}</p>
      {prompt?.user_code && <p className="hub-code" aria-label="Claude code">{prompt.user_code}</p>}
      {prompt?.wants_code && <form onSubmit={(event) => void submit(event)}><label>Code from Claude <input ref={codeInput} defaultValue="" autoComplete="off" spellCheck={false} /></label> <button className="btn" type="submit">Submit code</button></form>}
      <button type="button" className="btn" onClick={() => { clearCode(); run.current?.abort(); const id = active.current; active.current = null; setLogin(null); if (id) void api.claudeCancel(id).catch((cause) => setError(text(cause))); }}>Cancel</button></div>
      : <p><button type="button" className="btn" disabled={!prerequisites || value.claude.state === "unavailable"} onClick={() => void start(signedIn)}>{signedIn ? "Sign in again" : "Sign in to Claude"}</button></p>}
    {!prerequisites && <p className="hub-muted">Save your choices first. No agent starts until every step is done.</p>}
    {error && <Problem>{error}</Problem>}</Step>;
}

/**
 * Linear's callback query, handed out once for the page's life: the first call reads it and removes it from the
 * address bar (`replace` gets the path without it); every later call answers null. "Refresh page data" mounts the
 * callback page again, and that mount must find no code to send a second time.
 */
export function callbackOnce(read: () => { pathname: string; search: string }, replace: (path: string) => void): () => string | null {
  let taken = false;
  return () => {
    if (taken) return null;
    taken = true;
    const { pathname, search } = read();
    if (search) replace(pathname);
    return pathname === "/linear/callback" ? search : "";
  };
}

/**
 * Where Linear sends the person back (`<hub origin>/linear/callback?code&state`). The code is one-time and
 * secret: `take` (callbackOnce) removes it from the address at once and never hands it out again, and the code
 * goes only to the person's own registered factory, which holds the verifier it needs. The hub's own page
 * never reads it or forwards it.
 */
export function LinearCallback({ identity, deps, take }: { identity: Bootstrap["me"]; deps: SetupDeps; take: () => string | null }) {
  const [result, setResult] = useState<{ state: "working" } | { state: "done"; name: string } | { state: "failed"; message: string }>({ state: "working" });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const search = take();
    if (search === null) { setResult({ state: "failed", message: "This Linear sign-in was already used on this page. Open Setup to see whether Linear is connected." }); return; }
    const params = new URLSearchParams(search);
    const code = params.get("code");
    const state = params.get("state");
    if (params.get("error") || !code || !state) { setResult({ state: "failed", message: params.get("error") === "access_denied" ? "Linear was not approved. You can connect it again." : "Linear returned no sign-in code. Connect Linear again." }); return; }
    void (async () => {
      try {
        const overview = await deps.overview(new AbortController().signal);
        const mine = overview.factories.find((f) => f.state === "ready" && ownerOrigin(overview, identity.person, f.factory) !== null);
        if (!mine) throw new Error("Your factory is not ready, so Linear was not connected. Open Setup to see its progress.");
        const done = await deps.owner(ownerOrigin(overview, identity.person, mine.factory)!).linearCallback(code, state);
        setResult({ state: "done", name: done.name });
        deps.navigate("/setup");
      } catch (error) {
        setResult({ state: "failed", message: error instanceof FactoryUnreachable ? "Your factory did not answer with your sign-in. Open Setup, sign in to your factory, and connect Linear again." : text(error) });
      }
    })();
  }, [take, deps, identity.person]);
  if (result.state === "working") return <p role="status">Finishing the Linear connection…</p>;
  if (result.state === "done") return <p role="status">Linear connected as {result.name}. Returning to Setup…</p>;
  return <section role="alert" className="hub-notice"><h2>Linear was not connected</h2><p>{result.message}</p><p><a className="btn" href="/setup">Back to Setup</a></p></section>;
}
