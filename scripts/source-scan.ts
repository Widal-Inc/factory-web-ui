/**
 * Helpers for the repo-wide convention tests (src/, server/ and scripts/conventions.test.ts):
 * they read the checked-in sources as text and fail with an instruction for the next change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const repo = join(import.meta.dir, "..");

export const read = (file: string): string => readFileSync(join(repo, file), "utf8");

/** Repository-relative paths matching a glob, sorted; `node_modules` is never included. */
export const files = (pattern: string): string[] =>
  [...new Bun.Glob(pattern).scanSync({ cwd: repo })].filter((file) => !file.split("/").includes("node_modules")).sort();

/** Throws one message, the instruction first and then each offender, when there are offenders. */
export function fail(offenders: string[], instruction: string): void {
  if (offenders.length) throw new Error(`${instruction}\n  ${offenders.join("\n  ")}`);
}

/** The text of a string up to its closing quote, from just after the opening one: a line ends one that is not a template literal, and a backslash escapes the next character. */
const BODY: Record<string, RegExp> = {
  "\"": /[^"\\\n]*(?:\\[\s\S][^"\\\n]*)*/y,
  "'": /[^'\\\n]*(?:\\[\s\S][^'\\\n]*)*/y,
  "`": /[^`\\]*(?:\\[\s\S][^`\\]*)*/y,
};

/**
 * The source with every comment blanked out, character for character (newlines kept, so offsets
 * and line numbers still match). Strings and template literals are kept as written, or blanked
 * too with `strings`, so that a brace or keyword inside one is not read as code. A `/` that
 * starts a regular expression literal is not told apart from division, which only matters for a
 * regex holding a quote or `//`; the files these tests read have none that matter.
 */
export function stripComments(text: string, { strings = false } = {}): string {
  // spaces for every character but the newlines
  const blank = (part: string): string => part.includes("\n") ? part.replace(/[^\n]/g, " ") : " ".repeat(part.length);
  // Code between comments and strings is copied as one slice, and the next comment or string is
  // found with a regular expression, not a character at a time: the repo-wide scans run this over
  // every source file, and a per-character append made that the bulk of the convention tests'
  // CPU time (they run under a 5 s deadline, on a host that is often busy).
  const parts: string[] = [];
  const start = /\/[/*]|["'`]/g; // where a comment or a string can begin
  let copied = 0;
  for (let i = 0; ;) {
    start.lastIndex = i;
    const found = start.exec(text);
    if (found === null) break;
    i = found.index;
    if (found[0].length === 2) {
      const close = found[0] === "//" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : found[0] === "//" ? close : close + 2;
      parts.push(text.slice(copied, i), blank(text.slice(i, end)));
      copied = end;
      i = end;
      continue;
    }
    const quote = found[0];
    // the string's body: up to its closing quote, or to the line's end for a quote that opens no template literal
    const body = BODY[quote]!;
    body.lastIndex = i + 1;
    body.test(text);
    let j = body.lastIndex;
    if (text[j] === "\\") j += 2; // a backslash that ends the file escapes nothing
    if (strings) {
      parts.push(text.slice(copied, i), quote + blank(text.slice(i + 1, j)) + text.slice(j, j + 1));
      copied = j + 1;
    }
    i = j + 1;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

/** The 1-based line of an offset. */
export const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;
