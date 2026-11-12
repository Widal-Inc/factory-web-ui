import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecrets, saveSecrets } from "./factory-setup-store.ts";
import { privateStateFs } from "./private-state.ts";

// Only made-up values: nothing here is a real credential.
const dir = mkdtempSync(join(tmpdir(), "factory-setup-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

function file(content: string | null): string {
  const path = join(mkdtempSync(join(dir, "case-")), "widal", "secrets.env");
  if (content !== null) { saveSecrets(path, {}); writeFileSync(path, content, { mode: 0o600 }); }
  return path;
}

describe("the factory's secrets file", () => {
  it("keeps every line it does not own exactly as it is, and changes only the names it sets or removes", () => {
    const provisioned = [
      "# written by the factory's installer",
      "export AWS_REGION=us-east-1",
      "EMPTY_ON_PURPOSE=",
      "",
      "  # an indented comment",
      "export GH_TOKEN=old-github",
      "LINEAR_ACCESS_TOKEN=old-linear",
      "LINEAR_REFRESH_TOKEN=old-refresh",
      "not a definition at all",
      "QUOTED=\"keep me\"",
    ].join("\n") + "\n";
    const path = file(provisioned);
    saveSecrets(path, { GH_TOKEN: "new-github", LINEAR_ACCESS_TOKEN: "new-linear" }, ["LINEAR_REFRESH_TOKEN"]);
    expect(readFileSync(path, "utf8")).toBe([
      "# written by the factory's installer",
      "export AWS_REGION=us-east-1",
      "EMPTY_ON_PURPOSE=",
      "",
      "  # an indented comment",
      "export GH_TOKEN=new-github",
      "LINEAR_ACCESS_TOKEN=new-linear",
      "not a definition at all",
      "QUOTED=\"keep me\"",
    ].join("\n") + "\n");
    expect(readSecrets(path)).toEqual({ AWS_REGION: "us-east-1", EMPTY_ON_PURPOSE: "", GH_TOKEN: "new-github", LINEAR_ACCESS_TOKEN: "new-linear", QUOTED: "keep me" });
  });

  it("writes into a CRLF file without failing, keeping its line endings, and reads its values without the CR", () => {
    const path = file("# provisioned on another system\r\nEXTRA=1\r\nGH_TOKEN=old\r\n");
    expect(readSecrets(path)).toEqual({ EXTRA: "1", GH_TOKEN: "old" });
    saveSecrets(path, { GH_TOKEN: "new", LINEAR_ACCESS_TOKEN: "linear" });
    expect(readFileSync(path, "utf8")).toBe("# provisioned on another system\r\nEXTRA=1\r\nGH_TOKEN=new\r\nLINEAR_ACCESS_TOKEN=linear\r\n");
    saveSecrets(path, {}, ["GH_TOKEN"]);
    expect(readFileSync(path, "utf8")).toBe("# provisioned on another system\r\nEXTRA=1\r\nLINEAR_ACCESS_TOKEN=linear\r\n");
  });

  it("adds a name after a last line without a newline, and rewrites a name defined twice once", () => {
    const path = file("GH_TOKEN=first\nOTHER=x\nGH_TOKEN=second");
    expect(readSecrets(path)["GH_TOKEN"]).toBe("second");
    saveSecrets(path, { GH_TOKEN: "third", LINEAR_ACCESS_TOKEN: "linear" });
    expect(readFileSync(path, "utf8")).toBe("GH_TOKEN=third\nOTHER=x\nLINEAR_ACCESS_TOKEN=linear\n");
  });

  it("starts a new file with its header, private to its owner, in a private folder", () => {
    const path = file(null);
    saveSecrets(path, { GH_TOKEN: "github", LINEAR_REFRESH_TOKEN: "" });
    expect(readFileSync(path, "utf8")).toBe("# the factory's secrets, written by its web Setup. Keep this file private.\nGH_TOKEN=github\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  it("narrows a wider existing mode to the owner only", () => {
    const path = file("OTHER=x\n");
    chmodSync(path, 0o644);
    saveSecrets(path, { GH_TOKEN: "github" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a value of more than one line and leaves the file as it was", () => {
    const path = file("OTHER=x\n");
    expect(() => saveSecrets(path, { GH_TOKEN: "a\nEVIL=1" })).toThrow();
    expect(() => saveSecrets(path, { "BAD NAME": "x" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("OTHER=x\n");
  });

  it("keeps a line that is not UTF-8 byte for byte, and writes only characters a shell takes literally", () => {
    const path = file("");
    const head = Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9, 0xff, 0xfe, 0x0a]), Buffer.from("OTHER="), Buffer.from([0xe9]), Buffer.from("x\n")]);
    writeFileSync(path, Buffer.concat([head, Buffer.from("GH_TOKEN=old\n")]));
    saveSecrets(path, { GH_TOKEN: "new", LINEAR_ACCESS_TOKEN: "lin_Ab-1.2_3+4/5=:x" });
    expect(readFileSync(path)).toEqual(Buffer.concat([head, Buffer.from("GH_TOKEN=new\nLINEAR_ACCESS_TOKEN=lin_Ab-1.2_3+4/5=:x\n")]));
    for (const unsafe of ["a b", "a;b", "$(x)", "`x`", "a'b", "a\"b", "a#b", "a\\b", "a&b", "a|b", "a<b", "a>b", "a*b", "a?b", "a~b", "aéb", "a\nb", "a\rb"]) {
      expect(() => saveSecrets(path, { GH_TOKEN: unsafe }), unsafe).toThrow();
    }
    expect(readFileSync(path).includes(Buffer.from("GH_TOKEN=new\n"))).toBe(true);
  });

  it("writes through a flushed temporary file of its own and renames it over the file, flushing the folder", () => {
    const path = file("OTHER=x\n");
    const calls: string[] = [];
    for (const op of ["openSync", "fsyncSync", "renameSync"] as const) {
      const real = privateStateFs[op] as (...args: unknown[]) => unknown;
      spies.push(spyOn(privateStateFs, op).mockImplementation(((...args: unknown[]) => { calls.push(`${op} ${typeof args[0] === "string" ? args[0].replace(path, "<file>").replace(/\.\d+\.[0-9a-f]{12}\.tmp$/, ".<tmp>") : "fd"}${op === "openSync" ? ` ${String(args[1])}` : ""}`); return real(...args); }) as never));
    }
    saveSecrets(path, { GH_TOKEN: "github" });
    expect(calls).toEqual(["openSync <file>.<tmp> wx", "fsyncSync fd", `renameSync <file>.<tmp>`, `openSync ${join(path, "..")} r`, "fsyncSync fd"]);
    expect(readdirSync(join(path, ".."))).toEqual(["secrets.env"]);
  });

  it("never writes through a link: one at the old fixed temporary name or at the file itself is replaced, not followed", () => {
    const path = file("OTHER=x\n");
    const elsewhere = join(dir, `elsewhere-${Math.random().toString(16).slice(2)}`);
    writeFileSync(elsewhere, "untouched\n");
    symlinkSync(elsewhere, `${path}.${process.pid}.tmp`);
    saveSecrets(path, { GH_TOKEN: "github" });
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");
    rmSync(path);
    symlinkSync(elsewhere, path);
    saveSecrets(path, { GH_TOKEN: "github" });
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readSecrets(path)["GH_TOKEN"]).toBe("github");
  });
});
