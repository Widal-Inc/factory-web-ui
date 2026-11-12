/**
 * The hub UI artifact (`bun run build:hub` -> dist-hub/): the factory hub's My Factory, Team,
 * Quality and Admin pages, served from the origin root with `--ui-dir`. It is built apart from the
 * personal factory client (vite.config.ts), which stays unchanged, and holds public files only:
 * the entry, its hashed bundle, the BRAND images, the theme boot script, the notices as HTML,
 * build.json (freshness) and widal-ui.json (the release manifest the hub checks at start). No source
 * maps, no service worker, no offline cache. The build needs a Git checkout: the hub refuses a
 * release that does not name the full commit it was built from.
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BRAND } from "./shared/brand.ts";
import { brandIndex } from "./scripts/brand-metadata.ts";
import { BUILD_FILE, dropTruetypeFallbacks, HUB_MANIFEST_FILE, assertPublicArtifact, brandAssetPaths, buildManifest, noticePage, sourceRepository, type ArtifactFile } from "./scripts/hub-artifact.ts";
import { themeBootstrapBuild } from "./scripts/theme-bootstrap-build.ts";
import { buildTarget, clientAliases, clientDefines, gitRevision, repoRoot } from "./scripts/vite-shared.ts";

const revision = gitRevision();
if (revision === null) throw new Error("The hub UI release names the commit it was built from: build.hub needs a Git checkout.");
// SOURCE_DATE_EPOCH (seconds) makes the release's one time-dependent field reproducible
const builtAt = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000) : new Date();
const outDir = join(repoRoot, "dist-hub");
const assets = brandAssetPaths(BRAND);
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { repository: { url: string } };

/** The page's name, description and icon addresses come from BRAND, never from the HTML source. */
const brandPage: Plugin = {
  name: "hub-brand-page",
  transformIndexHtml: { order: "pre", handler: (html) => brandIndex(html) },
};

/** Trusted public files only: the BRAND images, copied by name from public/ (never the whole folder), and the notices as HTML pages. */
const publicFiles: Plugin = {
  name: "hub-public-files",
  generateBundle() {
    // legal attribution travels with the artifact, in a file type the hub serves
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.html", source: noticePage("Third-party notices", readFileSync(join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8")) });
    this.emitFile({ type: "asset", fileName: "LICENSE.html", source: noticePage("License", readFileSync(join(repoRoot, "LICENSE"), "utf8")) });
    // the page reads the commit it was built from
    this.emitFile({ type: "asset", fileName: BUILD_FILE, source: `${JSON.stringify({ revision })}\n` });
  },
  closeBundle() {
    // the hub does not serve TrueType: no stylesheet may name one, and none stays in the artifact
    for (const file of listFiles(outDir)) {
      if (file.path.endsWith(".css")) {
        const css = readFileSync(join(outDir, file.path), "utf8");
        const stripped = dropTruetypeFallbacks(css);
        if (stripped !== css) writeFileSync(join(outDir, file.path), stripped);
      } else if (file.path.endsWith(".ttf")) unlinkSync(join(outDir, file.path));
    }
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

/** Last: refuses a non-public file, then writes the release manifest the hub checks every file against. */
const manifest: Plugin = {
  name: "hub-manifest",
  enforce: "post",
  closeBundle: { order: "post", handler() {
    const files = listFiles(outDir).filter((file) => file.path !== HUB_MANIFEST_FILE);
    assertPublicArtifact(files.map((file) => file.path), assets);
    writeFileSync(join(outDir, HUB_MANIFEST_FILE), `${JSON.stringify(buildManifest(files, { revision, source: sourceRepository(packageJson.repository.url), builtAt }), null, 2)}\n`);
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
