import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "../shared/brand.ts";
import { brandIndex, brandManifest, brandWorker, renderBrandMetadata } from "./brand-metadata.ts";

const root = join(import.meta.dir, "..");
const other = { ...BRAND, name: 'Example & <Lab> "Tools"', shortName: "Example", theme: "amber", logo: "/brand/example.svg", icon: "/example-192.png", largeIcon: "/example-512.png", maskableIcon: "/example-maskable.png", badge: "/example-badge.png", favicon: "/example-favicon.png", appleTouchIcon: "/example-touch.png" };

it("keeps committed first-paint and background identity fresh", () => {
  for (const { path, content } of renderBrandMetadata(root)) expect(content, path).toBe(readFileSync(join(root, path), "utf8"));
});

it("switches static identity from a second config and escapes HTML", () => {
  const page = brandIndex(readFileSync(join(root, "index.html"), "utf8"), other);
  expect(page).toContain("<title>Example &amp; &lt;Lab&gt; \"Tools\"</title>");
  expect(page).toContain('href="/example-touch.png"');
  expect(page).not.toContain("ovis.sh");
  const manifest = JSON.parse(brandManifest(readFileSync(join(root, "public/manifest.webmanifest"), "utf8"), other));
  expect(manifest.name).toBe(other.name);
  expect(manifest.short_name).toBe(other.shortName);
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([other.icon, other.largeIcon, other.maskableIcon]);
  expect(manifest.id).toBe("/");
  expect(manifest.start_url).toBe("/");
  const worker = brandWorker("const BRAND = {};\nconst example = 'user content';", other);
  expect(worker).toContain(JSON.stringify(other.name));
  expect(worker).toContain("const example = 'user content';");
  expect(() => brandWorker("", other)).toThrow("exactly one");
});
