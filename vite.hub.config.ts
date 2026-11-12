/**
 * The hub UI artifact (`bun run build:hub` -> dist-hub/): the factory hub's My Factory, Team,
 * Quality and Admin pages, served from the origin root with `--ui-dir`. It is built apart from the
 * personal factory client (vite.config.ts), which stays unchanged, and holds public files only:
 * the entry, its hashed bundle, the BRAND images, the theme boot script, build.json (freshness)
 * and hub-manifest.json (integrity). No source maps, no service worker, no offline cache.
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BRAND } from "./shared/brand.ts";
import { brandIndex } from "./scripts/brand-metadata.ts";
import { HUB_MANIFEST_FILE, assertPublicArtifact, brandAssetPaths, buildManifest, type ArtifactFile } from "./scripts/hub-artifact.ts";
import { themeBootstrapBuild } from "./scripts/theme-bootstrap-build.ts";
import { appVersion, buildTarget, clientAliases, clientDefines, gitRevision, repoRoot } from "./scripts/vite-shared.ts";

const revision = gitRevision();
const outDir = join(repoRoot, "dist-hub");
const assets = brandAssetPaths(BRAND);

/** The page's name, description and icon addresses come from BRAND, never from the HTML source. */
const brandPage: Plugin = {
  name: "hub-brand-page",
  transformIndexHtml: { order: "pre", handler: (html) => brandIndex(html) },
};

/** Trusted public files only: the BRAND images, copied by name from public/ (never the whole folder), and the notice. */
const publicFiles: Plugin = {
  name: "hub-public-files",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: readFileSync(join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8") });
    // the page reads the commit it was built from; a build outside Git has none and says so
    if (revision !== null) this.emitFile({ type: "asset", fileName: "build.json", source: `${JSON.stringify({ revision })}\n` });
  },
  closeBundle() {
    for (const path of assets) {
      const to = join(outDir, path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(repoRoot, "public", path), to);
    }
  },
};

function listFiles(root: string, dir = root): ArtifactFile[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(root, path);
    return [{ path: relative(root, path).split("\\").join("/"), bytes: new Uint8Array(readFileSync(path)) }];
  });
}

/** Last: refuses a non-public file, then writes the manifest every file's sha256 is checked against. */
const manifest: Plugin = {
  name: "hub-manifest",
  enforce: "post",
  closeBundle: { order: "post", handler() {
    const files = listFiles(outDir).filter((file) => file.path !== HUB_MANIFEST_FILE);
    assertPublicArtifact(files.map((file) => file.path), assets);
    writeFileSync(join(outDir, HUB_MANIFEST_FILE), `${JSON.stringify(buildManifest(files, { revision, appVersion: appVersion(), brand: BRAND }), null, 2)}\n`);
  } },
};

export default defineConfig({
  root: join(repoRoot, "hub-app"),
  base: "/",
  publicDir: false,
  plugins: [react(), brandPage, themeBootstrapBuild(), publicFiles, manifest],
  define: clientDefines(revision),
  server: { port: 5174, fs: { allow: [repoRoot] } },
  build: { outDir, emptyOutDir: true, sourcemap: false, target: buildTarget },
  resolve: { alias: clientAliases() },
});
