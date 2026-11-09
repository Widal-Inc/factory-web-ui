import type { HealthAuth } from "../../shared/protocol.ts";

/**
 * Whether this browser can end the sign-in it got in with: a token it typed. Not this PC's own
 * access, which nothing here holds; nor a token a proxy sends with every request, which would come
 * right back.
 */
export function canSignOut(auth: HealthAuth | null): boolean {
  if (auth?.authenticated !== true) return false;
  return auth.via === "token" && auth.bearer !== true;
}
