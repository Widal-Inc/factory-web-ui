import { describe, expect, test } from "bun:test";
import { BRAND } from "../shared/brand.ts";
import { HUB_MANIFEST_FILE, HUB_MANIFEST_SCHEMA, assertPublicArtifact, brandAssetPaths, buildManifest, dropTruetypeFallbacks, isPublicArtifactPath, manifestProblem, noticePage, sourceRepository, verifyManifest } from "./hub-artifact.ts";

const text = (value: string) => new TextEncoder().encode(value);
const revision = "a".repeat(40);
const builtAt = new Date("2026-11-12T08:00:00.000Z");
const meta = { revision, source: "Example-Org/example-ui", builtAt };
const assets = brandAssetPaths(BRAND);
const files = [{ path: "index.html", bytes: text("<html>") }, { path: "assets/a.js", bytes: text("a") }];

describe("hub artifact", () => {
  test("brand assets are root-relative paths without the cache query", () => {
    expect(assets).toContain("favicon.png");
    expect(assets).toContain("brand/mark.svg");
    expect(assets.every((path) => !path.includes("?") && !path.startsWith("/"))).toBe(true);
    expect(() => brandAssetPaths({ ...BRAND, logo: "../secret.png" })).toThrow();
    expect(() => brandAssetPaths({ ...BRAND, logo: "https://example.com/x.png" })).toThrow();
  });

  test("only public files of a type the hub serves are accepted", () => {
    for (const accepted of ["index.html", "assets/index-abc123.js", "favicon.png", "build.json", "THIRD_PARTY_NOTICES.html", "LICENSE.html"]) {
      expect(isPublicArtifactPath(accepted, assets), accepted).toBe(true);
    }
    // the notices as Markdown are a type the hub refuses at start
    for (const refused of ["THIRD_PARTY_NOTICES.md", "assets/index.js.map", "../x", "/etc/passwd", "settings.json.bak", "assets/nested/a.js", "sw.js", ".env", "assets/.hidden.js", "assets\\a.js"]) {
      expect(isPublicArtifactPath(refused, assets), refused).toBe(false);
    }
    expect(() => assertPublicArtifact(["index.html", "assets/a.js.map"], assets)).toThrow("not public");
    expect(() => assertPublicArtifact(["assets/a.js"], assets)).toThrow("no index.html");
  });

  test("the manifest follows the factory hub's release schema", () => {
    const manifest = buildManifest(files, meta);
    expect(manifest.schema).toBe(HUB_MANIFEST_SCHEMA);
    expect(HUB_MANIFEST_FILE).toBe("widal-ui.json");
    expect(manifest.revision).toBe(revision);
    expect(manifest.hubApi).toEqual({ min: 1, max: 1 });
    expect(manifest.entry).toBe("index.html");
    expect(manifest.provenance).toEqual({ source: "Example-Org/example-ui", commit: revision, builtAt: "2026-11-12T08:00:00.000Z" });
    expect(manifest.files).toEqual([
      { path: "assets/a.js", bytes: 1, sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" },
      { path: "index.html", bytes: 6, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(Object.keys(manifest).sort()).toEqual(["entry", "files", "hubApi", "provenance", "revision", "schema"]);
    expect(manifestProblem(manifest)).toBeUndefined();
  });

  test("the manifest is stable, never lists itself, and refuses a build without a commit", () => {
    const manifest = buildManifest(files, meta);
    expect(buildManifest([...files].reverse(), meta)).toEqual(manifest);
    expect(buildManifest([...files, { path: HUB_MANIFEST_FILE, bytes: text("{}") }], meta).files).toHaveLength(2);
    expect(buildManifest([{ ...files[0]!, bytes: text("<html>x") }, files[1]!], meta).files[1]!.sha256).not.toBe(manifest.files[1]!.sha256);
    expect(() => buildManifest(files, { ...meta, revision: null })).toThrow("full commit id");
    expect(() => buildManifest(files, { ...meta, revision: "abc123" })).toThrow("full commit id");
    expect(() => buildManifest(files, { ...meta, builtAt: new Date("nope") })).toThrow("not a date");
  });

  test("a manifest the hub would refuse is refused here too", () => {
    const good = buildManifest(files, meta);
    const refuse = (change: object, expected: string, version?: number) => expect(manifestProblem({ ...good, ...change }, version)).toContain(expected);
    refuse({ schema: 1 }, "schema is not widal.ui/1");
    refuse({ revision: "abc" }, "full commit id");
    refuse({ hubApi: { min: 2, max: 1 } }, "whole numbers");
    refuse({ hubApi: { min: 2, max: 3 } }, "hub API 2 to 3");
    refuse({ hubApi: { min: 1, max: 1 } }, "hub API 1 to 1", 2);
    refuse({ entry: "app.html" }, "entry");
    refuse({ files: [] }, "no files");
    refuse({ files: [good.files[0]!] }, "does not list index.html");
    refuse({ files: [...good.files, { path: "x.map", bytes: 1, sha256: "0".repeat(64) }] }, "does not serve");
    refuse({ files: [...good.files, { path: "a/../b.js", bytes: 1, sha256: "0".repeat(64) }] }, "plain relative path");
    refuse({ files: [...good.files, good.files[0]!] }, "listed twice");
    refuse({ files: [...good.files, { path: HUB_MANIFEST_FILE, bytes: 1, sha256: "0".repeat(64) }] }, "lists itself");
    refuse({ files: [{ path: "index.html", bytes: 1, sha256: "short" }] }, "not {path, bytes, sha256}");
    refuse({ provenance: { source: "", commit: revision, builtAt: "2026-11-12T08:00:00.000Z" } }, "provenance");
    refuse({ provenance: { source: "a/b", commit: revision, builtAt: "yesterday" } }, "provenance");
    expect(manifestProblem(null)).toContain("not a JSON object");
  });

  test("a consumer detects a missing, changed or extra file", () => {
    const manifest = buildManifest(files, meta);
    expect(verifyManifest(manifest, files, assets)).toEqual([]);
    expect(verifyManifest(manifest, files.slice(0, 1), assets)).toEqual(["assets/a.js is listed but missing"]);
    expect(verifyManifest(manifest, [files[0]!, { path: "assets/a.js", bytes: text("b") }], assets)).toEqual(["assets/a.js differs from the manifest"]);
    expect(verifyManifest(manifest, [...files, { path: "assets/b.js", bytes: text("b") }], assets)).toEqual(["assets/b.js is not in the manifest"]);
    expect(verifyManifest({ ...manifest, hubApi: { min: 2, max: 2 } }, files, assets)[0]).toContain("hub API");
  });

  test("notices keep their full text in a page the hub serves, with markup inert", () => {
    const page = noticePage("Third-party notices", "MIT License <b>\nCopyright & \"others\"");
    expect(page).toContain("<title>Third-party notices</title>");
    expect(page).toContain("MIT License &lt;b&gt;\nCopyright &amp; &quot;others&quot;");
    expect(page).not.toContain("<b>");
    expect(page).not.toContain("<script");
  });

  test("the source repository is read from the package's repository url", () => {
    expect(sourceRepository("git+https://github.com/Example-Org/example-ui.git")).toBe("Example-Org/example-ui");
    expect(sourceRepository("https://github.com/Example-Org/example-ui")).toBe("Example-Org/example-ui");
    expect(() => sourceRepository("https://example.com/x")).toThrow("GitHub");
  });

  test("TrueType fallbacks leave the stylesheet, because the hub does not serve them", () => {
    const face = '@font-face{src:url(/assets/K-1.woff2)format("woff2"),url(/assets/K-1.woff)format("woff"),url(/assets/K-1.ttf)format("truetype")}';
    expect(dropTruetypeFallbacks(face)).toBe('@font-face{src:url(/assets/K-1.woff2)format("woff2"),url(/assets/K-1.woff)format("woff")}');
    expect(dropTruetypeFallbacks('a{src: url(x.woff2) format("woff2"), url(x.ttf) format(\'truetype\')}')).toBe('a{src: url(x.woff2) format("woff2")}');
    expect(dropTruetypeFallbacks("a{color:red}")).toBe("a{color:red}");
  });
});
