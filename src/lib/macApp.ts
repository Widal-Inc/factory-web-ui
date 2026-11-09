/** Whether this page runs in Ovis for Mac's own window (app/mac), which names itself in the user agent. */
export function inMacApp(): boolean {
  return typeof navigator !== "undefined" && /\bOvisMac\//.test(navigator.userAgent);
}
