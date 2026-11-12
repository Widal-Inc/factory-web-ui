/**
 * Export web app icons from the brand's vector source. Requires ffmpeg with SVG support.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BRAND } from "../shared/brand.ts";

const root = new URL("..", import.meta.url).pathname;
const icon = join(root, BRAND.iconSource);
mkdirSync(join(root, "public/icons"), { recursive: true });

function exportImage(source: string, path: string, filter: string, extra: string[] = []): void {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", source,
    "-vf", filter, "-frames:v", "1", "-threads", "1", ...extra, join(root, path),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not export ${path}`);
  console.log(path);
}

for (const size of [192, 512]) {
  exportImage(icon, `public/icons/icon-${size}.png`, `scale=${size}:${size}:flags=lanczos`);
  exportImage(icon, `public/icons/icon-maskable-${size}.png`,
    `scale=${size}:${size}:flags=lanczos`);
}
// Android draws a notification's small icon from its alpha alone: the sheep becomes white on
// transparent, cropped to it, its closed eyes and mouth left out so the face still reads.
// Without it Chrome shows its own bell.
exportImage(icon, "public/icons/badge-96.png",
  "scale=96:96:flags=lanczos,format=rgba,geq=r=255:g=255:b=255:a='alpha(X,Y)*clip((r(X,Y)+g(X,Y)+b(X,Y))/3-110,0,40)/40'");
exportImage(icon, "public/apple-touch-icon.png", "scale=180:180:flags=lanczos");
exportImage(icon, "public/favicon.png", "scale=64:64:flags=lanczos");
exportImage(icon, "public/favicon.ico", "scale=32:32:flags=lanczos", ["-c:v", "bmp"]);
// GitHub and the chat apps want 1280 × 640: scaled to that width, the empty band above and below
// the icon is trimmed evenly
exportImage(icon, "public/social-preview.png", "scale=640:640:flags=lanczos,pad=1280:640:(ow-iw)/2:0:color=0x181818");
