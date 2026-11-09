import { describe, expect, it } from "bun:test";
import type { HealthAuth } from "../../shared/protocol.ts";
import { canSignOut } from "./signOut.ts";

const in_ = (patch: Partial<HealthAuth>): HealthAuth => ({ required: false, authenticated: true, role: "drive", ...patch });

describe("which sign-ins this browser can end", () => {
  it("ends a token it typed and a paired device's", () => {
    expect(canSignOut(in_({ via: "token" }))).toBe(true);
    expect(canSignOut(in_({ via: "device" }))).toBe(true);
  });

  it("does not offer it where there is nothing to forget or it would come right back", () => {
    // a proxy sends its token with every request
    expect(canSignOut(in_({ via: "token", bearer: true }))).toBe(false);
    // this PC and an open server hold no sign-in of this browser's
    for (const via of ["local", "open"] as const) expect(canSignOut(in_({ via }))).toBe(false);
    expect(canSignOut(in_({}))).toBe(false);
    expect(canSignOut({ required: true, authenticated: false, reason: "token_required" })).toBe(false);
    expect(canSignOut(null)).toBe(false);
  });
});
