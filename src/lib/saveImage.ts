/**
 * Saving a picture where a download link would not save it (#3118). A home-screen web app follows
 * a link to the PC's own address as a page, and the picture replaced the app, with no way back.
 * There the picture goes to the share sheet instead, whose Save Image keeps it. Everywhere else
 * the link downloads as before.
 */
import { drawnPng } from "./clipboard.ts";
import { getTransport } from "./transport.ts";

/** Whether a download link here would load the file over the app instead of saving it. */
export function downloadLeavesApp(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * The picture `src` as a file named `name`. A PC path is read through the transport, as the page's
 * CSP lets no fetch reach a blob: or data: URL (a custom transport's pictures can be blob: URLs once shown);
 * any other picture is the decoded `shown` one, encoded as PNG.
 */
export async function imageFile(src: string, name: string, shown: HTMLImageElement | null, signal?: AbortSignal): Promise<File> {
  if (src.startsWith("/api/")) {
    const response = await getTransport().fetch(src, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return new File([blob], name, { type: blob.type });
  }
  if (shown === null) throw new Error("picture not shown");
  return new File([await drawnPng(shown)], name, { type: "image/png" });
}

/** How Download saves the picture here: a download link, or the share sheet. */
export function saveRoute(): "link" | "share" {
  return downloadLeavesApp() ? "share" : "link";
}

export type ShareOutcome = "shared" | "cancelled" | "failed";

/**
 * Offers `file` to the share sheet. WebKit opens it only within the tap that asked, so the file
 * must be in hand before the tap: call this first thing in the click.
 */
export async function shareFile(file: File): Promise<ShareOutcome> {
  const data = { files: [file] };
  if (typeof navigator.share !== "function" || navigator.canShare?.(data) === false) return "failed";
  try {
    await navigator.share(data);
    return "shared";
  } catch (error) {
    return error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
  }
}
