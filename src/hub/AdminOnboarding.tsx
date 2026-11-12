import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Bootstrap } from "./contract.ts";
import { HubError } from "./contract.ts";
import { GITHUB_ORGANIZATION, installUrl, LINEAR_CLIENT_ID, manifestForm, type Invite, type OnboardingApi, type OnboardingStatus } from "./onboardingApi.ts";

/** Posts GitHub's app manifest form from the browser, to the validated GitHub address only. */
export function submitManifestToGithub(form: { action: string; manifest: string }): void {
  const element = document.createElement("form");
  element.method = "POST";
  element.action = form.action;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = form.manifest;
  element.append(input);
  document.body.append(element);
  element.submit();
}

const POLL_MS = 4000;
const message = (error: unknown): string => error instanceof HubError || error instanceof Error ? error.message : "That did not work. Try again.";
type Role = "engineer" | "admin" | "viewer";
type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

function Panel({ title, children }: { title: string; children: ReactNode }) { return <section className="hub-panel"><h3>{title}</h3>{children}</section>; }
function Problem({ children }: { children: ReactNode }) { return <p role="alert" className="hub-problem">{children}</p>; }

/**
 * The Admin onboarding view: the organization's GitHub App and Linear app, then invites that deploy a
 * person's factory. It consumes the hub's onboarding API as it is; it stores nothing and asks for no personal
 * credential. Each step says plainly what the hub reported, including unavailable and failed.
 */
export function AdminOnboarding({ api, identity, pollMs = POLL_MS, submitForm = submitManifestToGithub }: { api: OnboardingApi; identity: Bootstrap["me"]; pollMs?: number; submitForm?: (form: { action: string; manifest: string }) => void }) {
  const [status, setStatus] = useState<Load<OnboardingStatus>>({ state: "loading" });
  const [invites, setInvites] = useState<Load<Invite[]>>({ state: "loading" });
  const [installed, setInstalled] = useState<"unknown" | "yes" | "no" | "error">("unknown");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [s, i] = await Promise.allSettled([api.status(signal), api.invites(signal)]);
    if (signal?.aborted) return;
    setStatus(s.status === "fulfilled" ? { state: "ready", value: s.value } : { state: "error", message: message(s.reason) });
    setInvites(i.status === "fulfilled" ? { state: "ready", value: i.value } : { state: "error", message: message(i.reason) });
    if (s.status === "fulfilled" && s.value.github) {
      try { setInstalled((await api.installation(signal)) ?.installed ? "yes" : "no"); } catch { if (!signal?.aborted) setInstalled("error"); }
    }
  }, [api]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  // a deployment takes minutes: follow it until nothing is still being made
  const creating = invites.state === "ready" && invites.value.some((i) => i.state === "creating");
  useEffect(() => {
    if (!creating) return undefined;
    const controller = new AbortController();
    const timer = setInterval(() => { api.invites(controller.signal).then((list) => { if (!controller.signal.aborted) setInvites({ state: "ready", value: list }); }, () => { /* the next tick tries again; the list keeps its last answer */ }); }, pollMs);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, creating, pollMs]);
  if (status.state === "loading") return <section aria-busy="true"><h2>Onboarding</h2><p role="status">Loading onboarding…</p></section>;
  if (status.state === "error") return <section><h2>Onboarding</h2><Problem>{status.message}</Problem><button type="button" className="btn" onClick={() => { setStatus({ state: "loading" }); void refresh(); }}>Try again</button></section>;
  const value = status.value;
  const github = value.github;
  const linearDone = value.usesLinear === false || value.linear !== undefined;
  const canInvite = github !== undefined && linearDone;
  return <section aria-labelledby="onboarding-title"><h2 id="onboarding-title">Onboarding</h2>
    <p className="hub-muted">Set up the organization once, then invite people. Each person connects their own GitHub, Linear and Claude on their own factory; none of those credentials come here.</p>
    <GithubStep status={value} installed={installed} api={api} submitForm={submitForm} />
    <LinearStep status={value} api={api} onSaved={() => refresh()} />
    <Panel title="Email"><p>{value.email.sendingEnabled ? "The hub sends the ready message by email." : "The hub does not send email yet."} {value.email.review}</p>{!value.email.sendingEnabled && <p className="hub-muted">Until sending is enabled, each invite shows its link to copy and send yourself.</p>}</Panel>
    <InviteStep api={api} canInvite={canInvite} identity={identity} invites={invites} setInvites={setInvites} why={!github ? "Create the GitHub App first." : "Register the Linear app, or choose that your team does not use Linear, first."} />
  </section>;
}

function GithubStep({ status, installed, api, submitForm }: { status: OnboardingStatus; installed: "unknown" | "yes" | "no" | "error"; api: OnboardingApi; submitForm: (form: { action: string; manifest: string }) => void }) {
  const [organization, setOrganization] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create(event: FormEvent) {
    event.preventDefault();
    const name = organization.trim();
    if (!GITHUB_ORGANIZATION.test(name)) { setError("Enter the GitHub organization's name, such as example-org."); return; }
    setBusy(true); setError(null);
    try {
      const made = await api.manifest(name);
      // The hub names GitHub's own page; the browser posts the manifest there and GitHub sends the admin back.
      submitForm(manifestForm(made));
    } catch (cause) { setError(message(cause)); setBusy(false); }
  }
  const app = status.github;
  if (app) {
    const link = installUrl(app.slug);
    return <Panel title="1. GitHub App"><p>Connected: <strong>{app.slug}</strong> for {app.organization}.</p>
      <p>{installed === "yes" ? "The app is installed on the organization's repositories." : installed === "no" ? "The app is not installed yet." : installed === "error" ? "The hub could not check the installation. Reload to try again." : "Checking the installation…"}</p>
      {installed !== "yes" && link && <p><a className="btn" href={link} rel="noreferrer">Install the app on your repositories</a></p>}
      <p className="hub-muted">Also open the app's settings on GitHub and enable <strong>Device Flow</strong>: people connect their own GitHub with it, and GitHub's manifest cannot turn it on.</p></Panel>;
  }
  return <Panel title="1. GitHub App"><p>Create one GitHub App for your organization. You need to be an organization owner or app manager.</p>
    <form onSubmit={(event) => void create(event)}><label>GitHub organization <input value={organization} onChange={(event) => setOrganization(event.target.value)} autoComplete="off" spellCheck={false} placeholder="example-org" /></label> <button className="btn" type="submit" disabled={busy}>{busy ? "Opening GitHub…" : "Create the GitHub App"}</button></form>
    {error && <Problem>{error}</Problem>}</Panel>;
}

function LinearStep({ status, api, onSaved }: { status: OnboardingStatus; api: OnboardingApi; onSaved: () => void }) {
  const [clientId, setClientId] = useState(status.linear?.clientId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(change: { clientId: string } | { usesLinear: false }) {
    setBusy(true); setError(null);
    try { await api.linear(change); onSaved(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  const disabled = status.github === undefined;
  return <Panel title="2. Linear app"><p>{status.usesLinear === false ? "Your team does not use Linear." : status.linear ? `Registered. Client ID ${status.linear.clientId}.` : "Register a Linear OAuth app for the organization, then enter its client ID. Never enter its secret here."}</p>
    <p>Callback address to register in Linear: <code>{status.linearCallback}</code></p>
    <form onSubmit={(event) => { event.preventDefault(); if (!LINEAR_CLIENT_ID.test(clientId.trim())) setError("Enter the Linear app's client ID: letters, numbers, dashes and underscores."); else void save({ clientId: clientId.trim() }); }}>
      <label>Client ID <input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} disabled={disabled} /></label> <button className="btn" type="submit" disabled={busy || disabled}>{status.linear ? "Update client ID" : "Save client ID"}</button>{" "}
      <button className="btn" type="button" disabled={busy || disabled || status.usesLinear === false} onClick={() => void save({ usesLinear: false })}>My team does not use Linear</button></form>
    {disabled && <p className="hub-muted">Create the GitHub App first.</p>}{error && <Problem>{error}</Problem>}</Panel>;
}

function deliveryText(invite: Invite): string {
  if (invite.state === "failed") return "No message sent";
  if (invite.state === "creating") return "Waiting for the factory";
  return invite.delivery === "sent" ? "Ready message emailed" : invite.delivery === "manual" ? "Copy the link and send it yourself" : invite.delivery === "failed" ? "The email failed: copy the link and send it yourself" : "Waiting to send";
}

function InviteStep({ api, canInvite, why, identity, invites, setInvites }: { api: OnboardingApi; canInvite: boolean; why: string; identity: Bootstrap["me"]; invites: Load<Invite[]>; setInvites: (value: Load<Invite[]>) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("engineer");
  const [factory, setFactory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  async function reload() { try { setInvites({ state: "ready", value: await api.invites() }); } catch (cause) { if (alive.current) setInvites({ state: "error", message: message(cause) }); } }
  async function run(action: () => Promise<string>) {
    setBusy(true); setError(null); setNote(null);
    try { const done = await action(); if (alive.current) setNote(done); await reload(); } catch (cause) { if (alive.current) setError(message(cause)); } finally { if (alive.current) setBusy(false); }
  }
  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!/^[^\s@/<>]+@[^\s@/<>]+\.[^\s@/<>]+$/.test(email.trim())) { setError("Enter the person's email address."); return; }
    await run(async () => {
      const result = await api.invite({ email: email.trim(), role, ...(factory.trim() ? { factory: factory.trim() } : {}) });
      setEmail("");
      return result.invite ? `Deploying ${result.invite.factory} for ${result.person}. Progress is below.` : `${result.person} now has the ${result.role} role and can sign in. No factory is made for this role.`;
    });
  }
  return <Panel title="3. People and factories">
    <form onSubmit={(event) => void invite(event)}>
      <label>Email <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" disabled={!canInvite} /></label>{" "}
      <label>Role <select value={role} onChange={(event) => setRole(event.target.value as Role)} disabled={!canInvite}><option value="engineer">Engineer (gets a factory)</option><option value="admin">Admin</option><option value="viewer">Viewer</option></select></label>{" "}
      <label>Factory name (optional) <input value={factory} onChange={(event) => setFactory(event.target.value)} autoComplete="off" spellCheck={false} disabled={!canInvite || role !== "engineer"} /></label>{" "}
      <button className="btn" type="submit" disabled={!canInvite || busy}>Invite</button></form>
    <p><button className="btn" type="button" disabled={!canInvite || busy} onClick={() => void run(async () => { const made = await api.createMine(); return `Deploying ${made.factory} for ${identity.person}. Progress is below.`; })}>Create my own factory</button></p>
    {!canInvite && <p className="hub-muted">{why}</p>}{error && <Problem>{error}</Problem>}{note && <p role="status">{note}</p>}
    {invites.state === "loading" ? <p role="status">Loading invites…</p> : invites.state === "error" ? <Problem>{invites.message}</Problem> : !invites.value.length ? <p>No invites yet.</p> : <div className="hub-table-wrap"><table><caption className="hub-muted">Current invite for each person</caption><thead><tr><th scope="col">Person</th><th scope="col">Factory</th><th scope="col">State</th><th scope="col">Delivery</th></tr></thead><tbody>
      {invites.value.map((i) => <tr key={i.id}><th scope="row">{i.owner}</th><td>{i.factory}</td><td>{i.state === "creating" ? "Deploying…" : i.state === "ready" ? (i.usedAt ? "Ready, opened by the person" : "Ready") : i.state === "failed" ? "Failed" : "Removed"}{i.progressAt && i.state === "creating" && <span className="hub-muted"> · last progress {new Date(i.progressAt).toLocaleTimeString()}</span>}{i.error && <span role="alert" className="hub-problem"> {i.error}</span>}</td>
        <td>{deliveryText(i)}{i.state === "ready" && !i.usedAt && !i.replacedAt && (i.delivery === "manual" || i.delivery === "failed") && <><br /><input readOnly aria-label={`Ready link for ${i.owner}`} value={i.link} onFocus={(event) => event.currentTarget.select()} /></>}
          {(i.state === "ready" || i.state === "failed") && <><br /><button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const again = await api.invite({ email: i.owner, role: "engineer", factory: i.factory }); return `Invited ${again.person} again.`; })}>{i.state === "failed" ? "Try again" : "Send a fresh link"}</button></>}</td></tr>)}
    </tbody></table></div>}
  </Panel>;
}
