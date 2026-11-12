/** Expected legacy product sentences in tests, including selectors with regular expressions. */
import { BRAND, brandTemplate } from "../shared/brand.ts";

export function brandedExpected(value: string): string;
export function brandedExpected(value: RegExp): RegExp;
export function brandedExpected(value: string | RegExp): string | RegExp {
  if (typeof value === "string") return brandTemplate(value);
  const escaped = BRAND.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(value.source.replace(/Ovis/g, () => escaped), value.flags);
}
