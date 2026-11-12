/** Product identity only. Storage, environment and wire identifiers keep their compatibility names. */
import config from "./brand.json";

export interface BrandConfig {
  name: string;
  shortName: string;
  description: string;
  theme: string;
  logo: string;
  iconSource: string;
  icon: string;
  largeIcon: string;
  maskableIcon: string;
  badge: string;
  favicon: string;
  appleTouchIcon: string;
  emailSender: { name: string; address: string | null };
}

export const BRAND: Readonly<BrandConfig> = Object.freeze(config);

/**
 * Legacy translation templates retain their lookup keys. Brand the template before filling
 * placeholders: a person's pane name, error detail or transcript must never be rewritten.
 */
export function brandTemplate(template: string, name: string = BRAND.name): string {
  return template.replace(/Ovis/g, () => name);
}

/** The future invitation sender must be configured before use; this bridge sends no email. */
export function emailSender(): string | null {
  const address = BRAND.emailSender.address;
  return address === null ? null : `${BRAND.emailSender.name} <${address}>`;
}
