import { App } from "../App.tsx";
import { AppCrash } from "../components/AppCrash.tsx";
import { FileReader } from "../components/FileReader.tsx";
import { RenderBoundary } from "../components/RenderBoundary.tsx";
import { ReaderFactoryContext, type ReaderTarget } from "../lib/fileReader.ts";
import { SettingsProvider } from "../lib/settings.ts";
import "../lib/viewport.ts";

/** The fork's App, unchanged, in the same boundaries src/main.tsx gives it. */
export default function FactoryApp({ factory, reader }: { factory: string; reader?: ReaderTarget }) {
  return <RenderBoundary resetKey={null} fallback={(_retry, error) => <AppCrash error={error} />}>
    <ReaderFactoryContext.Provider value={factory}>
      <SettingsProvider>{reader ? <FileReader target={reader} /> : <App />}</SettingsProvider>
    </ReaderFactoryContext.Provider>
  </RenderBoundary>;
}
