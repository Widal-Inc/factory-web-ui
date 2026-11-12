/** Real browser metadata and file elements across two HTTPS fixture origins, with a fake ALB. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { handleRequest, type ServerContext } from "../server/dispatch.ts";
import { FactoryAuth } from "../server/factory-auth.ts";
import { factoryFixture } from "../server/factory-auth.fake.ts";
import { createServer } from "../server/index.ts";
import { chromePath } from "./chrome-path.ts";
import { unitHerdrOnly } from "./test-herdr.ts";
import { fixtureBootstrap, fixtureOverview } from "../src/hub/fixtures.ts";

export async function checkFactoryFileView(hubUiDir?: string): Promise<void> {
  const restore = unitHerdrOnly();
  const root = mkdtempSync(join(tmpdir(), "factory-file-browser-"));
  const repo = join(import.meta.dir, "..");
  const identity = factoryFixture();
  let owner: ReturnType<typeof Bun.serve> | undefined;
  let hub: ReturnType<typeof Bun.serve> | undefined;
  let app: ReturnType<typeof createServer> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
    const tls = { key: Bun.file(key), cert: Bun.file(cert) };
    const requests: Array<{ path: string; site: string | null; mode: string | null; status: number; signed: boolean }> = [];
    const hubRequests: string[] = [];
    const loginEvents: string[] = [];
    let onCancelled: (() => void) | undefined;
    let loginRunning = false;
    let readerAllowed = true;
    let ctx: ServerContext;
    let ownerOrigin = "";
    owner = Bun.serve({ hostname: "127.0.0.1", port: 0, tls, async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("host", new URL(ownerOrigin).host);
      headers.set("x-forwarded-proto", "https");
      // The fixture ALB adds identity after the browser request, never in frontend state.
      headers.delete("x-amzn-oidc-data");
      if (headers.get("cookie")?.includes("fixture_alb=owner")) headers.set("x-amzn-oidc-data", identity.token());
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
      const response = (await handleRequest(new Request(`${ownerOrigin}${url.pathname}${url.search}`, { method: request.method, headers, body }), ctx))!;
      requests.push({ path: url.pathname, site: headers.get("sec-fetch-site"), mode: headers.get("sec-fetch-mode"), status: response.status, signed: headers.has("x-amzn-oidc-data") });
      if (response.status >= 400) console.error(JSON.stringify(requests.at(-1)));
      return response;
    } });
    ownerOrigin = `https://owner.example.test:${owner.port}`;
    let js: Blob;
    hub = Bun.serve({ hostname: "127.0.0.1", port: 0, tls, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/entry.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      if (hubUiDir && url.pathname === "/api/app/bootstrap") return Response.json({ ...fixtureBootstrap, me: { ...fixtureBootstrap.me, person: readerAllowed ? identity.options.owner : "other@example.com", factories: [registration()] } });
      if (hubUiDir && url.pathname === "/api/app/my/overview") return Response.json({ ...fixtureOverview, factories: [registration()], live: [{ factory: identity.options.factory, connection: { state: "direct", origin: ownerOrigin } }] });
      if (url.pathname.startsWith("/api/")) hubRequests.push(url.pathname);
      assert.ok(!url.pathname.startsWith("/api/"), "personal file requests must reach the owner");
      if (hubUiDir && (url.pathname === "/my-factory" || url.searchParams.has("read"))) return new Response(Bun.file(join(hubUiDir, "index.html")), { headers: { "content-type": "text/html" } });
      if (hubUiDir && /^\/(?:assets\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)$/.test(url.pathname)) {
        const file = Bun.file(join(hubUiDir, url.pathname));
        if (file.size) return new Response(file);
      }
      return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${readFileSync(join(repo, "src/styles.css"), "utf8")}\n${readFileSync(join(repo, "src/components/FileViewer.css"), "utf8")}</style><div id="root"></div><script type="module" src="/entry.js"></script>`, { headers: { "content-type": "text/html" } });
    } });
    const hubOrigin = `https://hub.example.test:${hub.port}`;
    const registration = () => ({ ...fixtureOverview.factories[0]!, factory: identity.options.factory, owner: identity.options.owner, address: ownerOrigin, state: "ready" });
    identity.setMe({ person: identity.options.owner, role: "engineer", factories: [{ factory: identity.options.factory, owner: identity.options.owner, address: ownerOrigin, state: "ready" }] });
    const auth = new FactoryAuth({ ...identity.options, origin: ownerOrigin, hubOrigin });
    app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, sidecar: false, machines: false, factoryAuth: auth });
    ctx = { ...app.context, requestIP: () => ({ address: "10.1.2.4" }), timeout: () => {}, upgrade: () => false };
    // Synthetic CLI operations, inside the real signed/current-owner dispatch and CORS boundary.
    // No CLI, real credentials, terminal or provider is contacted by these UI action checks.
    ctx = { ...ctx, services: { ...ctx.services, usageLogin: {
      async handle(request: Request) {
        if (request.method === "GET") return Response.json({ accounts: [] });
        const body = await request.json() as { follow?: boolean };
        if (loginRunning) return Response.json({ error: { code: "locked", message: "Previous login still holds the home" } }, { status: 409 });
        if (body.follow) { loginRunning = true; loginEvents.push("follow"); return Response.json({ login_id: "fixture-login", device_auth: true }); }
        loginEvents.push("terminal");
        return Response.json({ pane_id: "fixture-pane", workspace_id: "fixture-workspace", manual: false, device_auth: true });
      },
      async handlePrompt(request: Request) {
        if (new URL(request.url).pathname.endsWith("/cancel")) {
          assert.deepEqual(await request.json(), { login: "fixture-login" });
          loginRunning = false; loginEvents.push("cancel"); onCancelled?.(); return Response.json({ ok: true });
        }
        return Response.json({ provider: "codex", url: "https://login.example.com", user_code: "FIXTURE", wants_code: false, ended: false });
      },
    } as unknown as typeof app.context.services.usageLogin } };
    writeFileSync(join(root, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>');
    writeFileSync(join(root, "page.html"), '<!doctype html><h1 id="result">Waiting</h1><script>let isolated = false; try { parent.document.body; } catch { isolated = true; } document.querySelector("#result").textContent = isolated ? "Sandboxed fixture" : "Unsafe preview";</script>');
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32:d=1", "-c:v", "libvpx-vp9", join(root, "video.webm")]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1", join(root, "audio.wav")]);
    writeFileSync(join(root, "document.pdf"), "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    writeFileSync(join(root, "notes.md"), "# Owner notes\n\n[Next document](next.md)\n");
    writeFileSync(join(root, "next.md"), "# Next owner document\n");
    const entry = join(root, "entry.ts");
    writeFileSync(entry, `
      import React from ${JSON.stringify(join(repo, "node_modules/react/index.js"))};
      import { createRoot } from ${JSON.stringify(join(repo, "node_modules/react-dom/client.js"))};
      import { FileViewer } from ${JSON.stringify(join(repo, "src/components/FileViewer.tsx"))};
      import { SettingsProvider } from ${JSON.stringify(join(repo, "src/lib/settings.ts"))};
      import { setTransport } from ${JSON.stringify(join(repo, "src/lib/transport.ts"))};
      import { directTransport } from ${JSON.stringify(join(repo, "src/hub/directTransport.ts"))};
      import { ReaderFactoryContext } from ${JSON.stringify(join(repo, "src/lib/fileReader.ts"))};
      import { UsageSignInDialog } from ${JSON.stringify(join(repo, "src/components/UsageSignInDialog.tsx"))};
      setTransport(directTransport(${JSON.stringify(ownerOrigin)}, location.origin));
      const query = new URLSearchParams(location.search);
      const request = { provider: query.get("login") === "claude" ? "claude" : "codex", default: true };
      function Login() {
        const [result, setResult] = React.useState(null);
        return result ? React.createElement("p", { id: "result" }, result) : React.createElement(UsageSignInDialog, { request, onClose: () => setResult("Dialog closed"), onOpenTerminal: (pane) => setResult("Terminal " + pane) });
      }
      createRoot(document.getElementById("root")).render(React.createElement(ReaderFactoryContext.Provider, { value: ${JSON.stringify(identity.options.factory)} }, React.createElement(SettingsProvider, null, query.has("login") ? React.createElement(Login) : React.createElement(FileViewer, { path: query.get("path"), paneId: null, onClose: () => {} }))));
    `);
    const bundle = await Bun.build({ entrypoints: [entry], target: "browser", define: { "process.env.NODE_ENV": JSON.stringify("development") }, plugins: [{ name: "fixture-css", setup(build) {
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
    } }] });
    assert.ok(bundle.success, String(bundle.logs));
    js = bundle.outputs.find((output) => output.path.endsWith(".js"))!;
    assert.ok(js);
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP *.example.test 127.0.0.1"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([{ name: "fixture_alb", value: "owner", url: ownerOrigin, secure: true, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => { if (response.status() >= 400) console.error(`fixture response ${response.status()}: ${response.url()}`); });
    for (const [file, selector] of [["image.svg", "img.file-viewer-media"], ["video.webm", "video"], ["audio.wav", "audio"], ["document.pdf", "iframe.file-viewer-pdf"], ["page.html", "iframe.file-viewer-page"]]) {
      requests.length = 0;
      const fileResponse = page.waitForResponse((response) => response.url().startsWith(`${ownerOrigin}/api/fs/file?`)
        && (file !== "page.html" || new URL(response.url()).searchParams.get("render") === "1")
        && [200, 206].includes(response.status()));
      void fileResponse.catch(() => { console.error(JSON.stringify({ requests, errors })); });
      await page.goto(`${hubOrigin}/?path=${encodeURIComponent(join(root, file!))}`);
      const element = page.locator(selector!);
      await element.waitFor();
      assert.equal(new URL((await element.getAttribute("src"))!).origin, ownerOrigin, `${file} uses the registered owner`);
      const response = await fileResponse;
      if (file === "image.svg") await page.waitForFunction(() => (document.querySelector("img.file-viewer-media") as HTMLImageElement)?.naturalWidth === 32);
      if (file === "video.webm" || file === "audio.wav") await page.waitForFunction(() => (document.querySelector("video,audio") as HTMLMediaElement)?.readyState >= 1);
      if (file === "page.html") {
        await page.frameLocator("iframe.file-viewer-page").getByRole("heading", { name: "Sandboxed fixture" }).waitFor();
        assert.ok(response.headers()["content-security-policy"]?.includes(`frame-ancestors 'self' ${hubOrigin}`));
        await page.getByRole("button", { name: "Source", exact: true }).click();
        await page.locator(".file-viewer-text").waitFor();
        assert.ok((await page.locator(".file-viewer-text").innerText()).includes("<!doctype html>"), "CORS exposes the range metadata required by source preview");
      }
      assert.ok(requests.some((request) => request.signed && request.path === "/api/fs/stat" && request.mode === "cors" && request.site !== "same-origin" && request.status === 200), `${file}: browser CORS stat admitted`);
      assert.ok(requests.some((request) => request.signed && request.path === "/api/fs/file" && [200, 206].includes(request.status) && request.mode === (file === "document.pdf" || file === "page.html" ? "navigate" : "no-cors")), `${file}: real element request admitted`);
      console.log(`PASS owner file viewer: ${file}, cross-origin metadata and registered resource URL`);
    }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${hubOrigin}/?path=${encodeURIComponent(join(root, "notes.md"))}`);
      // The raw actions must resolve through the transport even while Markdown parsing is pending.
      if (width === 390) await page.getByRole("button", { name: "More", exact: true }).click();
      const raw = width === 390 ? page.getByRole("menuitem", { name: "Open raw file", exact: true }) : page.getByRole("link", { name: "Open raw file", exact: true });
      await raw.waitFor();
      assert.equal(new URL((await raw.getAttribute("href"))!).origin, ownerOrigin, "desktop/mobile raw action uses the registered owner");
      const rawOpened = page.waitForEvent("popup");
      await raw.click();
      const rawPage = await rawOpened;
      await rawPage.waitForLoadState();
      assert.ok((await rawPage.locator("body").innerText()).includes("# Owner notes"));
      await rawPage.close();
      console.log(`PASS owner raw file action: ${width}px, real link navigation`);
      if (!hubUiDir) continue;
      if (width === 390) await page.getByRole("button", { name: "More", exact: true }).click();
      const newTab = width === 390 ? page.getByRole("menuitem", { name: "Open in a new tab", exact: true }) : page.getByRole("link", { name: "Open in a new tab", exact: true });
      const link = new URL((await newTab.getAttribute("href"))!, hubOrigin);
      assert.equal(link.searchParams.get("factory"), identity.options.factory);
      const opened = page.waitForEvent("popup");
      await newTab.click();
      const reader = await opened;
      await reader.getByRole("heading", { name: "Owner notes", exact: true }).waitFor();
      assert.equal(await reader.getByRole("heading", { name: "My Factory", exact: true }).count(), 0);
      await reader.getByText("Next document", { exact: true }).click();
      await reader.getByRole("heading", { name: "Next owner document", exact: true }).waitFor();
      assert.equal(new URL(reader.url()).searchParams.get("factory"), identity.options.factory, "linked documents keep factory context");
      await reader.reload();
      await reader.getByRole("heading", { name: "Next owner document", exact: true }).waitFor();
      await reader.goBack();
      await reader.getByRole("heading", { name: "Owner notes", exact: true }).waitFor();
      await reader.close();
      readerAllowed = false;
      const denied = await context.newPage();
      await denied.goto(link.href);
      await denied.getByRole("heading", { name: "Document unavailable" }).waitFor();
      assert.equal(await denied.locator(".file-reader").count(), 0);
      await denied.close();
      readerAllowed = true;
      console.log(`PASS production hub reader: ${width}px, new tab/relative link/reload/Back/denied identity`);
    }
    for (const provider of ["claude", "codex"]) {
      for (const action of ["close", "terminal", "pagehide"]) {
        loginEvents.length = 0;
        await page.goto(`${hubOrigin}/?login=${provider}`);
        await page.getByRole("link", { name: "Open sign-in page", exact: true }).waitFor();
        assert.equal(loginRunning, true);
        // On navigation the old page no longer reports keepalive responses. Wait for the fixture
        // server to release the home instead, so this checks delivery rather than an obsolete page.
        const cancelled = Promise.withResolvers<void>();
        onCancelled = () => cancelled.resolve();
        const deadline = setTimeout(() => cancelled.reject(new Error(`Cancellation missing: ${JSON.stringify({ provider, action, loginEvents, hubRequests, requests: requests.slice(-8) })}`)), 15_000);
        try {
          if (action === "close") await page.getByRole("button", { name: "Close", exact: true }).click();
          else if (action === "terminal") await page.getByRole("button", { name: "Open terminal", exact: true }).click();
          else await page.goto(`${hubOrigin}/?path=${encodeURIComponent(join(root, "image.svg"))}`);
          await cancelled.promise;
        } finally { clearTimeout(deadline); onCancelled = undefined; }
        assert.equal(loginRunning, false);
        if (action === "terminal") {
          await page.getByText("Terminal fixture-pane", { exact: true }).waitFor();
          assert.deepEqual(loginEvents, ["follow", "cancel", "terminal"], "terminal handoff waits for cancellation to release the home");
        } else assert.deepEqual(loginEvents, ["follow", "cancel"]);
        console.log(`PASS owner sign-in action: ${provider} ${action}, synthetic CLI lock released`);
      }
    }
    assert.deepEqual(hubRequests, [], "no personal request fell back to the hub");
    identity.setMe({ person: identity.options.owner, role: "admin", factories: [] });
    const removed = await page.evaluate(async (url) => {
      try { return (await fetch(url, { credentials: "include" })).status; } catch { return "refused"; }
    }, `${ownerOrigin}/api/fs/stat?path=${encodeURIComponent(join(root, "image.svg"))}`);
    assert.equal(removed, "refused", "revocation closes cross-origin data access");
    assert.equal(requests.at(-1)?.status, 403, "the signed request was denied for lost ownership");
    assert.deepEqual(errors, []);
    await context.close();
    console.log("PASS owner file viewer: revoked admin denied; rendered HTML stays sandboxed");
  } finally {
    await browser?.close();
    app?.stop();
    owner?.stop(true);
    hub?.stop(true);
    restore();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await checkFactoryFileView(process.env.FACTORY_HUB_UI_DIR);
