/** Static identity for the first paint, install sheet and background notifications. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "../shared/brand.ts";

export type Brand = typeof BRAND;

export function brandIndex(html: string, brand: Brand = BRAND): string {
  return new HTMLRewriter()
    .on("title", { element: (element) => { element.setInnerContent(brand.name); } })
    .on('meta[name="description"], meta[property="og:description"]', { element: (element) => { element.setAttribute("content", brand.description); } })
    .on('meta[property="og:title"], meta[name="apple-mobile-web-app-title"]', { element: (element) => { element.setAttribute("content", brand.name); } })
    .on('meta[property="og:image"]', { element: (element) => { element.setAttribute("content", brand.largeIcon); } })
    .on('meta[property="og:image:alt"]', { element: (element) => { element.setAttribute("content", brand.name); } })
    .on('meta[property="og:image:width"], meta[property="og:image:height"]', { element: (element) => { element.setAttribute("content", "512"); } })
    .on('link[rel="icon"]', { element: (element) => { element.setAttribute("href", brand.favicon); } })
    .on('link[rel="apple-touch-icon"]', { element: (element) => { element.setAttribute("href", brand.appleTouchIcon); } })
    .on("#root .visually-hidden", { element: (element) => { element.setInnerContent(`Loading ${brand.name}`); } })
    .transform(html);
}

export function brandManifest(json: string, brand: Brand = BRAND): string {
  return `${JSON.stringify({ ...JSON.parse(json), name: brand.name, short_name: brand.shortName, description: brand.description,
    icons: [
      { src: brand.icon, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: brand.largeIcon, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: brand.maskableIcon, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, null, 2)}\n`;
}

/** A plain script, with data serialized as JSON: no inline executable brand text. */
export function brandWorker(source: string, brand: Brand = BRAND): string {
  const marker = /^const BRAND = .*;$/gm;
  if ([...source.matchAll(marker)].length !== 1) throw new Error("public/sw.js must hold exactly one BRAND constant");
  return source.replace(marker, () => `const BRAND = ${JSON.stringify({ name: brand.name, icon: brand.icon, badge: brand.badge })};`);
}

export function renderBrandMetadata(root: string, brand: Brand = BRAND): { path: string; content: string }[] {
  return [
    { path: "index.html", render: brandIndex },
    { path: "public/manifest.webmanifest", render: brandManifest },
    { path: "public/sw.js", render: brandWorker },
  ].map(({ path, render }) => ({ path, content: render(readFileSync(join(root, path), "utf8"), brand) }));
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const check = process.argv.includes("--check");
  let stale = false;
  for (const { path, content } of renderBrandMetadata(root)) {
    if (readFileSync(join(root, path), "utf8") === content) continue;
    if (check) { console.error(`STALE ${path} - Run: bun scripts/brand-metadata.ts`); stale = true; }
    else { writeFileSync(join(root, path), content); console.log(`wrote ${path}`); }
  }
  if (stale) process.exit(1);
}
