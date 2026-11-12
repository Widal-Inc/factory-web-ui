import { compressedAssets } from "./scripts/compressed-assets.ts";
import { serviceWorkerBuild } from "./scripts/service-worker-build.ts";
import { themeBootstrapBuild } from "./scripts/theme-bootstrap-build.ts";
import { buildTarget, clientAliases, clientDefines, gitRevision } from "./scripts/vite-shared.ts";
import { renderBrandMetadata } from "./scripts/brand-metadata.ts";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// A config-only identity change must not ship a stale install sheet or notification worker.
for (const { path, content } of renderBrandMetadata(fileURLToPath(new URL(".", import.meta.url)))) {
  if (readFileSync(new URL(path, import.meta.url), "utf8") !== content) throw new Error(`Stale brand metadata: ${path}. Run bun scripts/brand-metadata.ts`);
}

const revision = gitRevision();

// agentSvgMarks.ts carries LobeHub Icons paths (MIT): their notice ships with every built client
const thirdPartyNotices: Plugin = {
  name: "third-party-notices",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: readFileSync("THIRD_PARTY_NOTICES.md", "utf8") });
  },
};

// the commit this client was built from, read by the managed bridge that serves it (server/update-api.ts):
// a checkout rebuilt under a running server serves this build before the server runs it
const buildRevision: Plugin = {
  name: "build-revision",
  generateBundle() {
    if (revision !== null) this.emitFile({ type: "asset", fileName: "build.json", source: `${JSON.stringify({ revision })}\n` });
  },
};

export default defineConfig({
  // the theme boot script is emitted before compressedAssets and serviceWorkerBuild read the bundle
  plugins: [react(), thirdPartyNotices, buildRevision, themeBootstrapBuild(), compressedAssets(), serviceWorkerBuild()],
  define: clientDefines(revision),
  server: {
    port: 5173,
    proxy: {
      // not the string shorthand: Vite gives that changeOrigin, and the server's same-origin check
      // compares the browser's Origin (:5173) with the Host it was sent, which must stay :5173
      "/api": { target: "http://localhost:7317", changeOrigin: false },
      "/ws": { target: "ws://localhost:7317", ws: true },
    },
  },
  // Keep Vite 6's syntax targets when changing the bundler, including installed mobile clients.
  build: { outDir: "dist", target: buildTarget },
  // The Bun patch targets xterm's readable source, not its minified distribution. Build that
  // source so dev, production and the website use the same reviewed IME backport.
  resolve: { alias: clientAliases() },
});
