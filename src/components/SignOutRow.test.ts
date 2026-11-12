import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { SignOutRow } from "./SignOutRow.tsx";

/** English, whatever the machine running the test prefers. */
function render(): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(SignOutRow, { onSignOut: async () => undefined }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Sign out in Settings → Devices", () => {
  it("is a Sign out button that says the way back in is the access token", () => {
    const html = render();
    expect(html).toContain(">Sign out</button>");
    expect(html).toContain("Getting back in takes the access token.");
  });
});
