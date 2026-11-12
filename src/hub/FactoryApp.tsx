import { App } from "../App.tsx";
import { AppCrash } from "../components/AppCrash.tsx";
import { RenderBoundary } from "../components/RenderBoundary.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import "../lib/viewport.ts";

/** The fork's App, unchanged, in the same boundaries src/main.tsx gives it. */
export default function FactoryApp() {
  return <RenderBoundary resetKey={null} fallback={(_retry, error) => <AppCrash error={error} />}>
    <SettingsProvider><App /></SettingsProvider>
  </RenderBoundary>;
}
