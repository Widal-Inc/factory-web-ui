import { useEffect, useState, type ReactNode } from "react";
import { HubError, itemPath, ownerOrigin, parseAdmin, parseBootstrap, parseItem, parseOverview, parseQuality, parseToday, readHub, routeFor } from "./contract.ts";
import type { Admin, Bootstrap, Card, Cost, Item, Overview, Quality, Route, Today } from "./contract.ts";
import "./hub.css";
import { readerFromSearch, type ReaderTarget } from "../lib/fileReader.ts";

// These slots are integration boundaries, not alternate backends. The brand comes from the shared
// brand config; the owner view reuses the fork's chat/terminal/answer cards with a direct transport.
export interface HubSlots {
  brand: { name: string; logo: string };
  ownerView?: (connection: { factory: string; origin: string; reader?: ReaderTarget }) => ReactNode;
  setup?: (identity: Bootstrap["me"], view: "setup" | "linearCallback") => ReactNode;
  onboarding?: (identity: Bootstrap["me"]) => ReactNode;
}
type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string; status?: number };
export type PageData = { page: "my"; data: Overview } | { page: "today"; data: Today } | { page: "quality"; data: Quality } | { page: "admin"; data: Admin } | { page: "item"; data: Item };

async function pageData(route: Route, signal: AbortSignal): Promise<PageData | null> {
  switch (route.page) {
    case "my": return { page: "my", data: await readHub("/api/app/my/overview", parseOverview, signal) };
    case "today": return { page: "today", data: await readHub("/api/app/team/today", parseToday, signal) };
    case "quality": return { page: "quality", data: await readHub("/api/app/team/quality", parseQuality, signal) };
    case "admin": return { page: "admin", data: await readHub("/api/app/admin", parseAdmin, signal) };
    case "item": return { page: "item", data: await readHub(`/api/app${itemPath(route.factory, route.id)}`, parseItem, signal) };
    default: return null;
  }
}

/** Full navigations recheck signed identity for the page and its assets at the hub. No offline cache. */
export function HubApp(slots: HubSlots) {
  const route = routeFor(window.location.pathname);
  const [attempt, retry] = useState(0);
  const [bootstrap, setBootstrap] = useState<Load<Bootstrap>>({ state: "loading" });
  const [page, setPage] = useState<Load<PageData | null>>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setBootstrap({ state: "loading" });
    setPage({ state: "loading" });
    void (async () => {
      try {
        const boot = await readHub("/api/app/bootstrap", parseBootstrap, controller.signal);
        if (controller.signal.aborted) return;
        setBootstrap({ state: "ready", data: boot });
        if (route.page === "admin" && boot.me.role !== "admin") throw new HubError(403, "You do not have access to Admin.");
        const data = await pageData(route, controller.signal);
        if (!controller.signal.aborted) setPage({ state: "ready", data });
      } catch (error) {
        if (controller.signal.aborted) return;
        const failed: Load<never> = { state: "error", message: error instanceof Error ? error.message : "The page could not be loaded.", ...(error instanceof HubError ? { status: error.status } : {}) };
        // Clear all previous personal data after any refusal or refresh failure.
        setBootstrap(failed);
        setPage(failed);
      }
    })();
    return () => controller.abort();
  // A normal link navigation mounts a new document. Retries deliberately re-read identity too.
  }, [attempt]);
  const boot = bootstrap.state === "ready" ? bootstrap.data : null;
  const reader = readerFromSearch(window.location.search);
  if (reader !== null) {
    if (bootstrap.state === "loading" || page.state === "loading") return <p role="status">Loading your document…</p>;
    if (bootstrap.state === "error") return <section role="alert"><h1>{bootstrap.status === 401 ? "Sign in again" : "Document unavailable"}</h1><p>{bootstrap.message}</p>{bootstrap.status === 401 ? <a className="btn" href={window.location.pathname + window.location.search}>Reload and sign in</a> : <button className="btn" onClick={() => retry((n) => n + 1)}>Try again</button>}</section>;
    const factory = new URLSearchParams(window.location.search).get("factory");
    const origin = factory && boot && route.page === "my" && page.state === "ready" && page.data?.page === "my" ? ownerOrigin(page.data.data, boot.me.person, factory) : null;
    // A link carries an ID only. Every new document rechecks identity and registration before it
    // installs a transport; query parameters never supply an origin or grant an admin live access.
    return origin && factory && slots.ownerView ? slots.ownerView({ factory, origin, reader }) : <Notice title="Document unavailable">This document's factory is not available to your current sign-in.</Notice>;
  }
  return <div className="hub-app">
    <a className="hub-skip" href="#hub-main">Skip to content</a>
    <header className="hub-header"><a className="hub-brand" href="/my-factory"><img src={slots.brand.logo} alt="" />{slots.brand.name}</a><span>{boot?.me.person}</span></header>
    <nav className="hub-nav" aria-label="Main navigation">
      <Nav href="/my-factory" active={route.page === "my"}>My Factory</Nav>
      <Nav href="/team" active={["today", "quality", "item"].includes(route.page)}>Team</Nav>
      <Nav href="/setup" active={route.page === "setup" || route.page === "linearCallback"}>Setup</Nav>
      {boot?.me.role === "admin" && <Nav href="/admin" active={route.page === "admin"}>Admin</Nav>}
    </nav>
    <main id="hub-main" className="hub-main" tabIndex={-1}>
      {bootstrap.state === "loading" || page.state === "loading" ? <p role="status">Loading your factory…</p> : bootstrap.state === "error" ? <section role="alert"><h1>{bootstrap.status === 401 ? "Sign in again" : bootstrap.status === 403 ? "Access unavailable" : "Could not load the app"}</h1><p>{bootstrap.message}</p>{bootstrap.status === 401 ? <a className="btn" href={window.location.pathname}>Reload and sign in</a> : <button className="btn" onClick={() => retry((n) => n + 1)}>Try again</button>}</section> : page.state === "ready" && boot && <>
        {boot.beads.state === "unavailable" && <Notice title="Work data unavailable">{boot.beads.reason}</Notice>}
        {page.data ? <HubPage value={page.data} identity={boot.me} slots={slots} /> : route.page === "setup" || route.page === "linearCallback" ? <><h1>{route.page === "setup" ? "Setup" : "Connecting Linear"}</h1>{slots.setup?.(boot.me, route.page) ?? <Notice title="Setup unavailable">The setup service is not connected yet. Your credentials have not been requested or saved.</Notice>}</> : <><h1>Page not found</h1><a href="/my-factory">Back to My Factory</a></>}
        <button className="btn hub-refresh" onClick={() => retry((n) => n + 1)}>Refresh page data</button>
      </>}
    </main>
  </div>;
}

function Nav({ href, active, children }: { href: string; active: boolean; children: ReactNode }) { return <a href={href} aria-current={active ? "page" : undefined}>{children}</a>; }
export function Notice({ title, children }: { title: string; children: ReactNode }) { return <section className="hub-notice"><h2>{title}</h2><p>{children}</p></section>; }
function Time({ at }: { at: number }) { return <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time>; }
function Errors({ errors }: { errors: { factory: string; error: string }[] }) { return errors.length ? <Notice title="Some work data could not be read">{errors.map((e) => <span className="hub-line" key={e.factory}>{e.factory}: {e.error}</span>)}</Notice> : null; }
function CostSummary({ cost }: { cost: Cost }) {
  return <section className="hub-panel"><h2>Recorded work cost</h2><strong className="hub-metric">{cost.usd === null ? "Not reported" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cost.usd)}</strong><p>Reported by {cost.beads} work items. Cloud and model billing are not reported separately.</p>{cost.perFactory.map((f) => <p key={f.factory}>{f.factory}: ${f.usd.toFixed(2)}</p>)}</section>;
}
function WebLink({ href, children }: { href: string; children: ReactNode }) {
  // Ticket/PR metadata can contain arbitrary schemes. Never render those as executable links.
  try { const url = new URL(href); if (url.protocol === "https:" && !url.username && !url.password) return <a href={url.href} rel="noreferrer" target="_blank">{children}</a>; } catch { /* text fallback */ }
  return <span>{children} (link unavailable)</span>;
}
function Cards({ cards, empty }: { cards: Card[]; empty: string }) {
  return cards.length ? <ul className="hub-cards">{cards.map((c) => <li className="hub-panel" key={`${c.factory}/${c.id}`}><div className="hub-card-meta">{c.factory} · {c.id} · {c.kind}</div><h3><a href={itemPath(c.factory, c.id)}>{c.title}</a></h3><p>{c.why}</p><p>Next: {c.actsNext} · waiting {c.hours}h</p>{c.pr && <WebLink href={c.pr}>Pull request</WebLink>}</li>)}</ul> : <p>{empty}</p>;
}
export function HubPage({ value, identity, slots }: { value: PageData; identity: Bootstrap["me"]; slots: HubSlots }) {
  switch (value.page) {
    case "my": return <MyFactory data={value.data} person={identity.person} slots={slots} />;
    case "today": return <TeamToday data={value.data} />;
    case "quality": return <TeamQuality data={value.data} />;
    case "item": return <TeamItem data={value.data} />;
    case "admin": return identity.role === "admin" ? <AdminPage data={value.data} identity={identity} slots={slots} /> : <Notice title="Access unavailable">You do not have access to Admin.</Notice>;
  }
}
function MyFactory({ data, person, slots }: { data: Overview; person: string; slots: HubSlots }) {
  return <><h1>My Factory</h1><p className="hub-muted">Updated <Time at={data.asOf} /></p>
    {!data.factories.length && <Notice title="No factory yet">Finish setup to connect your own factory.</Notice>}
    {data.factories.map((f) => {
      const origin = ownerOrigin(data, person, f.factory);
      const connection = data.live.find((row) => row.factory === f.factory)?.connection;
      return <section className="hub-panel" key={f.factory}><h2>{f.factory}</h2><p>Factory: {f.state}</p>{origin && slots.ownerView ? slots.ownerView({ factory: f.factory, origin }) : <Notice title="Live agents unavailable">{connection?.state === "unavailable" ? connection.reason : "The direct owner connection is not connected yet. Chat, terminal, answer cards and agent state will appear here."}</Notice>}</section>;
    })}
    {data.work.state === "unavailable" ? <Notice title="Queue and cost unavailable">{data.work.reason}</Notice> : <>
      <Errors errors={data.work.errors} />
      <section><h2>Your queue</h2>{data.work.queue.factories.map((f) => <section key={f.factory}><h3>{f.factory}</h3>{f.read ? <Cards cards={f.cards} empty="No open work items." /> : <Notice title="Queue unavailable">This factory's work items could not be read.</Notice>}</section>)}</section>
      <CostSummary cost={data.work.cost} />
      <section className="hub-panel"><h2>Pull requests</h2>{!data.work.pullRequests.length && <p>No pull requests reported in your open queue.</p>}{data.work.pullRequests.map((pr) => <article key={`${pr.factory}/${pr.id}`}><h3><WebLink href={pr.url}>{pr.factory} · {pr.id}</WebLink></h3><p>Review unavailable: {pr.review.reason}</p><p>CI unavailable: {pr.ci.reason}</p></article>)}</section>
    </>}
    <Notice title="Subscription usage unavailable">{data.usageLimits.reason} Session and weekly usage, reset times and waiting for limit reset require the personal factory connection.</Notice>
  </>;
}
function TeamTabs({ quality = false }: { quality?: boolean }) { return <nav className="hub-tabs" aria-label="Team pages"><Nav href="/team" active={!quality}>Today</Nav><Nav href="/team/quality" active={quality}>Quality</Nav></nav>; }
function TeamToday({ data }: { data: Today }) {
  return <><h1>Team</h1><TeamTabs /><p>Work items from the central beads. Personal sessions stay private.</p><p className="hub-muted">Updated <Time at={data.asOf} /></p><Errors errors={data.errors} />
    <section><h2>Needs a person</h2><Cards cards={data.needsPerson} empty="No work items waiting on a person in the available data." /></section>
    <section><h2>Needs recovery</h2><Cards cards={data.broken} empty="No broken work items in the available data." /></section>
    <section className="hub-panel"><h2>Who acts next</h2>{data.actsNext.length ? <ul>{data.actsNext.map((a) => <li key={a.who}>{a.who}: {a.count}</li>)}</ul> : <p>No next actions reported.</p>}</section>
    <div className="hub-grid">{data.factories.map((f) => <section className="hub-panel" key={f.factory}><h2>{f.factory}</h2><p>{f.owner} · {f.state}</p>{f.read ? <p>{f.open} open · {f.working} working · {f.waitingOnPerson} waiting on a person · {f.broken} broken · {f.closedInWindow} closed in window</p> : <p>Work data unavailable</p>}</section>)}</div><CostSummary cost={data.cost} /><Trend data={data.trend} />
  </>;
}
function Trend({ data }: { data: Today["trend"] }) { return <section className="hub-panel"><h2>Recent trend</h2><p>Closed per day: {data.last7.closedPerDay} in the last 7 days; {data.before.closedPerDay} in the preceding 3 weeks.</p><p>Median completion: {data.last7.medianHours === null ? "Not reported" : `${data.last7.medianHours}h`}. Rejected share: {data.last7.rejectedShare === null ? "Not reported" : `${Math.round(data.last7.rejectedShare * 100)}%`}.</p></section>; }
function TeamQuality({ data }: { data: Quality }) {
  return <><h1>Team quality</h1><TeamTabs quality /><p className="hub-muted">Updated <Time at={data.asOf} /></p><Errors errors={data.errors} /><Trend data={data.trend} />
    <section className="hub-panel"><h2>Completed each day</h2><div className="hub-table-wrap"><table><thead><tr><th scope="col">Day (UTC)</th><th scope="col">Closed</th></tr></thead><tbody>{data.closedPerDay.map((d) => <tr key={d.day}><th scope="row">{d.day}</th><td>{d.closed}</td></tr>)}</tbody></table></div></section>
    <section className="hub-panel"><h2>By week</h2>{data.weeks.map((w) => <p key={w.weekStart}>{w.weekStart}: {w.closed} closed, {w.rejected} rejected, median {w.medianHours === null ? "not reported" : `${w.medianHours}h`}</p>)}</section>
    <section className="hub-panel"><h2>By factory</h2>{data.perFactory.map((f) => <p key={f.factory}>{f.factory}: {f.closed} closed, {f.rejected} rejected, median {f.medianHours === null ? "not reported" : `${f.medianHours}h`}</p>)}</section>
  </>;
}
function TeamItem({ data }: { data: Item }) {
  return <><a href="/team">Back to Team</a><p className="hub-muted">{data.bead.factory} · {data.bead.id}</p><h1>{data.bead.title}</h1><p>{data.bead.status} · priority {data.bead.priority}</p>{data.wait && <Notice title={`Next: ${data.wait.actsNext}`}>{data.wait.why} · since <Time at={data.wait.since} /></Notice>}
    {data.bead.pr && <p><WebLink href={data.bead.pr}>Pull request</WebLink></p>}{data.bead.externalRef && <p><WebLink href={data.bead.externalRef}>Ticket</WebLink></p>}{data.bead.costUsd !== undefined && <p>Recorded cost: ${data.bead.costUsd.toFixed(2)}</p>}
    <section className="hub-panel"><h2>Blocked by</h2>{data.blockedBy.length ? <ul>{data.blockedBy.map((b) => <li key={b.id}><a href={itemPath(data.bead.factory, b.id)}>{b.id}{b.title ? ` · ${b.title}` : ""}</a> · {b.status ?? "state unavailable"}</li>)}</ul> : <p>No blockers reported.</p>}</section>
    <section className="hub-panel"><h2>Work history</h2>{data.events.length ? <ol>{data.events.map((e, i) => <li key={i}><Time at={e.at} /> · {e.actor} · {e.type}{e.from && <p>From: {e.from}</p>}{e.to && <p>To: {e.to}</p>}{e.comment && <p>{e.comment}</p>}</li>)}</ol> : <p>No work history reported.</p>}</section>
  </>;
}
function AdminPage({ data, identity, slots }: { data: Admin; identity: Bootstrap["me"]; slots: HubSlots }) {
  return <><h1>Admin</h1><section className="hub-panel"><h2>People</h2><ul>{data.people.map((p) => <li key={p.person}>{p.person} · {p.role}</li>)}</ul></section>
    <section className="hub-panel"><h2>Registered factories</h2><ul>{data.factories.map((f) => <li key={f.factory}>{f.factory} · {f.owner} · {f.state}</li>)}</ul><p>Registration does not grant access to another person's sessions.</p></section>
    {data.capabilities.onboarding.state === "ready" ? slots.onboarding?.(identity) ?? <Notice title="Invites and onboarding unavailable">The hub offers onboarding, but this app build has no screens for it. Update the app.</Notice> : <Notice title="Invites and onboarding unavailable">{data.capabilities.onboarding.reason}</Notice>}
    <Notice title="Company sign-in unavailable">{data.capabilities.identityProvider.reason}</Notice>
    <Notice title="Branding controls unavailable">{data.capabilities.branding.reason}</Notice>
    <Notice title="Budget controls unavailable">{data.capabilities.budgets.reason}</Notice>
    <Notice title="Telemetry visibility unavailable">{data.capabilities.telemetry.reason} This does not mean telemetry is disabled.</Notice>
  </>;
}
