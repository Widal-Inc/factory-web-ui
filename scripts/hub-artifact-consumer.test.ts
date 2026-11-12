import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { BRAND } from "../shared/brand.ts";
import { HUB_MANIFEST_FILE, brandAssetPaths, buildManifest, noticePage, verifyManifest, type ArtifactFile } from "./hub-artifact.ts";

/**
 * The factory hub is the consumer of this artifact: `hub/src/ui.ts` there reads the release manifest at start.
 * Point FACTORY_HUB_UI at that file in a factory checkout (for example `/path/to/factory/hub/src/ui.ts`) and these
 * tests run the hub's own reader on a release made here, so producer and consumer cannot drift apart unseen.
 * They are skipped without it, because this repository does not hold the factory's source.
 */
const hubUi = process.env.FACTORY_HUB_UI;
const consumer = hubUi && existsSync(hubUi) ? ((await import(hubUi)) as { builtUi: (directory: string) => { release?: { revision: string; files: { path: string }[]; provenance: { source: string } } } }) : null;
const run = consumer ? describe : describe.skip;

const revision = "b".repeat(40);
const text = (value: string) => new TextEncoder().encode(value);

function listFiles(root: string, dir = root): ArtifactFile[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(root, path);
    return [{ path: relative(root, path).split("\\").join("/"), bytes: new Uint8Array(readFileSync(path)) }];
  });
}

function writeRelease(directory: string, files: ArtifactFile[]): void {
  for (const file of files) {
    mkdirSync(dirname(join(directory, file.path)), { recursive: true });
    writeFileSync(join(directory, file.path), file.bytes);
  }
  const manifest = buildManifest(files, { revision, source: "Example-Org/example-ui", builtAt: new Date("2026-11-12T08:00:00.000Z") });
  writeFileSync(join(directory, HUB_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

run("the factory hub reads a release made here", () => {
  const fixture = (): ArtifactFile[] => [
    { path: "index.html", bytes: text("<!doctype html><title>Example</title>") },
    { path: "assets/app-1a2b3c.js", bytes: text("console.log(1)") },
    { path: "THIRD_PARTY_NOTICES.html", bytes: text(noticePage("Third-party notices", "MIT License")) },
    { path: "build.json", bytes: text(`${JSON.stringify({ revision })}\n`) },
  ];

  test("accepts the release and reports its revision", () => {
    const directory = mkdtempSync(join(tmpdir(), "hub-release-"));
    try {
      writeRelease(directory, fixture());
      const release = consumer!.builtUi(directory).release;
      expect(release?.revision).toBe(revision);
      expect(release?.provenance.source).toBe("Example-Org/example-ui");
      expect(release?.files.map((file) => file.path)).toEqual(["THIRD_PARTY_NOTICES.html", "assets/app-1a2b3c.js", "build.json", "index.html"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("refuses a release whose file changed after the manifest was written", () => {
    const directory = mkdtempSync(join(tmpdir(), "hub-release-"));
    try {
      writeRelease(directory, fixture());
      writeFileSync(join(directory, "assets/app-1a2b3c.js"), "console.log(2)");
      expect(() => consumer!.builtUi(directory)).toThrow("does not match its size and SHA-256");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  // The directory `bun run build:hub` wrote, when there is one: the real bytes, not a fixture.
  const built = new URL("../dist-hub/", import.meta.url).pathname;
  (existsSync(join(built, HUB_MANIFEST_FILE)) ? test : test.skip)("accepts the built dist-hub and the producer's own check agrees", () => {
    const release = consumer!.builtUi(built).release;
    expect(release).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(built, HUB_MANIFEST_FILE), "utf8")) as unknown;
    expect(verifyManifest(manifest, listFiles(built), brandAssetPaths(BRAND))).toEqual([]);
    expect(release!.files.some((file) => file.path.endsWith(".ttf") || file.path.endsWith(".map") || file.path.endsWith(".md"))).toBe(false);
    expect(release!.files.map((file) => file.path)).toContain("THIRD_PARTY_NOTICES.html");
  });
});
