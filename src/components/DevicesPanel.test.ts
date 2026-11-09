import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HealthAuth } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";

/** English, whatever the machine running the test prefers. */
function render(auth: HealthAuth): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(DevicesPanel, { auth }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("how this browser got in", () => {
  it("says how a browser got in with the token", () => {
    const html = render({ required: false, authenticated: true, via: "token", role: "drive" });
    expect(html).toContain("You are in with the access token.");
  });
});
