import { expect, it } from "bun:test";
import { BRAND, brandTemplate, emailSender } from "./brand.ts";

it("changes product templates without interpreting replacement syntax", () => {
  expect(brandTemplate("Open Ovis", "Example $& <Lab>")).toBe("Open Example $& <Lab>");
  expect(brandTemplate("Ovisから削除済み")).toBe(`${BRAND.name}から削除済み`);
  expect(brandTemplate("OVIS_TOKEN and ovis:settings")).toBe("OVIS_TOKEN and ovis:settings");
});

it("leaves invitation email disabled until its sender is configured", () => {
  expect(emailSender()).toBeNull();
});
