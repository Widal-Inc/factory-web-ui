// Focused, fixture-only phone/desktop QA. This does not prove deployed contracts or owner sign-in.
import { chromium, type Browser } from "playwright-core";
import { basename } from "node:path";
import { fixtureAdmin, fixtureBootstrap, fixtureItem, fixtureOverview, fixtureQuality, fixtureToday } from "../src/hub/fixtures.ts";

const build = await Bun.build({
  entrypoints: [new URL("./hub-pages-fixture.tsx", import.meta.url).pathname],
  target: "browser", minify: true, publicPath: "/", naming: "[name]-[hash].[ext]",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const assets = new Map(build.outputs.map((out) => [`/${basename(out.path)}`, out]));
const script = build.outputs.find((out) => out.kind === "entry-point" && out.path.endsWith(".js"));
if (!script) throw new Error("Missing fixture script");
const css = build.outputs.filter((out) => out.path.endsWith(".css")).map((out) => `<link rel="stylesheet" href="/${basename(out.path)}">`).join("");
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hub page fixture</title>${css}</head><body><div id="root"></div><script type="module" src="/${basename(script.path)}"></script></body></html>`;
let refused = false;
let administrator = true;
const reads: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      reads.push(path);
      if (refused) return Response.json({ error: "removed fixture identity" }, { status: 403 });
      const data: Record<string, unknown> = {
        "/api/app/bootstrap": { ...fixtureBootstrap, me: { ...fixtureBootstrap.me, role: administrator ? "admin" : "engineer" } },
        "/api/app/my/overview": fixtureOverview,
        "/api/app/team/today": fixtureToday,
        "/api/app/team/quality": fixtureQuality,
        "/api/app/team/items/sample-factory/sample-1": fixtureItem,
        "/api/app/admin": fixtureAdmin,
      };
      return path in data ? Response.json(data[path], { headers: { "cache-control": "no-store" } }) : Response.json({ error: "fixture route missing" }, { status: 404 });
    }
    const asset = assets.get(path);
    if (asset) return new Response(asset);
    if (path === "/example.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Example</title><path fill="currentColor" d="M2 2h20v20H2z"/></svg>', { headers: { "content-type": "image/svg+xml" } });
    return new Response(html, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
  },
});
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const origin = `http://127.0.0.1:${server.port}`;
      const visible = async (text: string) => { await page.getByText(text, { exact: true }).waitFor({ state: "visible" }); };
      const noOverflow = async () => {
        if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(`Horizontal overflow at ${viewport.width}`);
      };
      administrator = true;
      refused = false;
      await page.goto(`${origin}/my-factory`);
      await visible("Subscription usage unavailable");
      await visible("Queue unavailable");
      await noOverflow();
      const teamStart = reads.length;
      await page.getByRole("link", { name: "Team", exact: true }).click();
      await page.getByRole("heading", { name: "Needs a person" }).waitFor();
      await noOverflow();
      if (reads.slice(teamStart).some((path) => path.includes("/my/") || !path.startsWith("/api/app/"))) throw new Error("Team requested personal data");
      await page.getByRole("link", { name: "Review the example change" }).click();
      await page.getByRole("heading", { name: "Work history" }).waitFor();
      await noOverflow();
      await page.goto(`${origin}/team/quality`);
      await page.getByRole("heading", { name: "By week" }).waitFor();
      await noOverflow();
      await page.goto(`${origin}/admin`);
      await visible("Telemetry visibility unavailable");
      await noOverflow();
      await page.goto(`${origin}/setup`);
      await page.getByRole("heading", { name: "Setup unavailable" }).waitFor();
      await page.goto(`${origin}/my-factory`);
      await visible("Subscription usage unavailable");
      refused = true;
      await page.getByRole("button", { name: "Refresh page data" }).click();
      await page.getByRole("heading", { name: "Access unavailable" }).waitFor();
      if (await page.getByText("Review the example change", { exact: true }).count()) throw new Error("Revoked page retained personal content");
      refused = false;
      administrator = false;
      const before = reads.length;
      await page.goto(`${origin}/admin`);
      await visible("You do not have access to Admin.");
      if (reads.slice(before).includes("/api/app/admin")) throw new Error("Non-admin requested admin data");
      if (errors.length) throw new Error(errors.join("\n"));
      console.log(`Hub fixture QA passed at ${viewport.width}x${viewport.height}`);
    } finally { await context.close(); }
  }
} finally {
  try { await browser?.close(); } finally { server.stop(true); }
}
