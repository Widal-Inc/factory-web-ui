import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HubPage, type HubSlots } from "./HubApp.tsx";
import { fixtureAdmin, fixtureBootstrap, fixtureItem, fixtureOverview, fixtureQuality, fixtureToday } from "./fixtures.ts";
const slots: HubSlots = { brand: { name: "Example app", logo: "/example-logo.svg" } };
const identity = fixtureBootstrap.me;
describe("hub pages", () => {
  it("shows partial queues, blocked reason and unknown cost/review/CI/limits honestly", () => {
    const html = renderToStaticMarkup(<HubPage value={{ page: "my", data: fixtureOverview }} identity={identity} slots={slots} />);
    for (const text of ["Waiting for a decision", "Queue unavailable", "Not reported", "Review unavailable", "CI unavailable", "Subscription usage unavailable", "Live agents unavailable"]) expect(html).toContain(text);
    expect(html).not.toContain("$0.00");
  });
  it("never opens someone else's live view, including for an admin", () => {
    let opens = 0;
    const live = { ...slots, ownerView: ({ origin }: { origin: string }) => { opens++; return <p>Direct {origin}</p>; } };
    renderToStaticMarkup(<HubPage value={{ page: "my", data: fixtureOverview }} identity={{ ...identity, person: "admin@example.com", role: "admin" }} slots={live} />);
    expect(opens).toBe(0);
    expect(renderToStaticMarkup(<HubPage value={{ page: "my", data: fixtureOverview }} identity={identity} slots={live} />)).toContain("Direct https://ada.factory.example.com");
    expect(opens).toBe(1);
  });
  it("Team never invokes a live-session renderer or links a factory address", () => {
    const html = renderToStaticMarkup(<HubPage value={{ page: "today", data: fixtureToday }} identity={identity} slots={{ ...slots, ownerView: () => { throw new Error("Team must not open sessions"); } }} />);
    expect(html).toContain("/team/items/sample-factory/sample-1");
    expect(html).toContain("Work data unavailable");
    expect(html).not.toContain("0 open");
    expect(html).not.toContain("ada.factory.example.com");
    expect(html).toContain("Rejected share: 20%");
  });
  it("quality keeps null durations distinct from zero and item history stays escaped", () => {
    expect(renderToStaticMarkup(<HubPage value={{ page: "quality", data: fixtureQuality }} identity={identity} slots={slots} />)).toContain("median not reported");
    const data = { ...fixtureItem, bead: { ...fixtureItem.bead, title: "<script>bad()</script>", pr: "javascript:alert(1)" } };
    const html = renderToStaticMarkup(<HubPage value={{ page: "item", data }} identity={identity} slots={slots} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("href=\"javascript:");
    expect(html).toContain("state unavailable");
  });
  it("requires Admin role and provides one producer-owned onboarding slot", () => {
    expect(renderToStaticMarkup(<HubPage value={{ page: "admin", data: fixtureAdmin }} identity={identity} slots={slots} />)).not.toContain("Registered factories");
    const html = renderToStaticMarkup(<HubPage value={{ page: "admin", data: fixtureAdmin }} identity={{ ...identity, role: "admin" }} slots={slots} />);
    expect(html).toContain("Invites and onboarding unavailable");
    expect(html).toContain("This does not mean telemetry is disabled");
    expect(html).not.toContain("<form");
  });
  it("renders the onboarding slot only when the hub says onboarding is ready, and says so when the build has none", () => {
    const ready = { ...fixtureAdmin, capabilities: { ...fixtureAdmin.capabilities, onboarding: { state: "ready" as const, endpoint: "/api/app/admin/onboarding" } } };
    const asAdmin = { ...identity, role: "admin" as const };
    const withSlot = { ...slots, onboarding: () => <p>Onboarding screens</p> };
    expect(renderToStaticMarkup(<HubPage value={{ page: "admin", data: ready }} identity={asAdmin} slots={withSlot} />)).toContain("Onboarding screens");
    expect(renderToStaticMarkup(<HubPage value={{ page: "admin", data: ready }} identity={asAdmin} slots={slots} />)).toContain("no screens for it");
    // an unavailable hub keeps its reason even when the build has the screens: nothing is offered that the hub cannot do
    const html = renderToStaticMarkup(<HubPage value={{ page: "admin", data: fixtureAdmin }} identity={asAdmin} slots={withSlot} />);
    expect(html).not.toContain("Onboarding screens");
    expect(html).toContain("Invites and onboarding unavailable");
  });
});
