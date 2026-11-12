import { describe, expect, test } from "bun:test";
import { BRAND } from "../shared/brand.ts";
import { HUB_API_VERSION, HUB_MANIFEST_FILE, assertPublicArtifact, brandAssetPaths, buildManifest, isPublicArtifactPath, verifyManifest } from "./hub-artifact.ts";

const text = (value: string) => new TextEncoder().encode(value);
const meta = { revision: "a".repeat(40), appVersion: "1.2.3", brand: BRAND };
const assets = brandAssetPaths(BRAND);

describe("hub artifact", () => {
  test("brand assets are root-relative paths without the cache query", () => {
    expect(assets).toContain("favicon.png");
    expect(assets).toContain("brand/mark.svg");
    expect(assets.every((path) => !path.includes("?") && !path.startsWith("/"))).toBe(true);
    expect(() => brandAssetPaths({ ...BRAND, logo: "../secret.png" })).toThrow();
    expect(() => brandAssetPaths({ ...BRAND, logo: "https://example.com/x.png" })).toThrow();
  });

  test("only public files are accepted", () => {
    expect(isPublicArtifactPath("index.html", assets)).toBe(true);
    expect(isPublicArtifactPath("assets/index-abc123.js", assets)).toBe(true);
    expect(isPublicArtifactPath("favicon.png", assets)).toBe(true);
    for (const refused of ["assets/index.js.map", "../x", "/etc/passwd", "settings.json", "assets/nested/a.js", "sw.js", ".env"]) {
      expect(isPublicArtifactPath(refused, assets), refused).toBe(false);
    }
    expect(() => assertPublicArtifact(["index.html", "assets/a.js.map"], assets)).toThrow("not public");
    expect(() => assertPublicArtifact(["assets/a.js"], assets)).toThrow("no index.html");
  });

  test("the manifest is stable, sorted and names the release", () => {
    const files = [{ path: "index.html", bytes: text("<html>") }, { path: "assets/a.js", bytes: text("a") }];
    const manifest = buildManifest(files, meta);
    expect(manifest.hubApiVersion).toBe(HUB_API_VERSION);
    expect(manifest.files.map((file) => file.path)).toEqual(["assets/a.js", "index.html"]);
    expect(buildManifest([...files].reverse(), meta).digest).toBe(manifest.digest);
    expect(buildManifest([{ ...files[0]!, bytes: text("<html>x") }, files[1]!], meta).digest).not.toBe(manifest.digest);
    expect(buildManifest([...files, { path: HUB_MANIFEST_FILE, bytes: text("{}") }], meta).files).toHaveLength(2);
    expect(manifest.revision).toBe(meta.revision);
    expect(buildManifest(files, { ...meta, revision: null }).revision).toBeNull();
  });

  test("a consumer detects a missing, changed or extra file", () => {
    const files = [{ path: "index.html", bytes: text("<html>") }, { path: "assets/a.js", bytes: text("a") }];
    const manifest = buildManifest(files, meta);
    expect(verifyManifest(manifest, files, assets)).toEqual([]);
    expect(verifyManifest(manifest, files.slice(0, 1), assets)).toEqual(["assets/a.js is listed but missing"]);
    expect(verifyManifest(manifest, [files[0]!, { path: "assets/a.js", bytes: text("b") }], assets)).toEqual(["assets/a.js differs from the manifest"]);
    expect(verifyManifest(manifest, [...files, { path: "assets/b.js", bytes: text("b") }], assets)).toEqual(["assets/b.js is not in the manifest"]);
    expect(verifyManifest({ ...manifest, hubApiVersion: 2 as never }, files, assets)[0]).toContain("hub API");
  });
});
