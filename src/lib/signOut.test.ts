import { describe, expect, it } from "bun:test";
import type { HealthAuth } from "../../shared/protocol.ts";
import { canSignOut } from "./signOut.ts";

const in_ = (patch: Partial<HealthAuth>): HealthAuth => ({ required: false, authenticated: true, ...patch });

describe("which sign-ins this browser can end", () => {
  it("ends a token it typed", () => {
    expect(canSignOut(in_({ via: "token" }))).toBe(true);
  });

  it("does not offer it where there is nothing to forget or it would come right back", () => {
    // a proxy sends its token with every request
    expect(canSignOut(in_({ via: "token", bearer: true }))).toBe(false);
    // this PC holds no sign-in of this browser's
    expect(canSignOut(in_({ via: "local" }))).toBe(false);
    expect(canSignOut(in_({}))).toBe(false);
    expect(canSignOut({ required: true, authenticated: false, reason: "token_required" })).toBe(false);
    expect(canSignOut(null)).toBe(false);
  });
});
