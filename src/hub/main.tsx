// first: every module below may call a built-in older browsers lack (lib/builtins.ts)
import "../lib/builtins.ts";
// then: every module below may read browser storage as it loads
import "../lib/legacyStorage.ts";
import { BRAND } from "../../shared/brand.ts";
import { AdminOnboarding } from "./AdminOnboarding.tsx";
import { mountHub } from "./mount.tsx";
import { createOnboardingApi } from "./onboardingApi.ts";
import { OwnerFactory } from "./OwnerFactory.tsx";
import { ownerSetupApi } from "./ownerSetupApi.ts";
import { browserSetupDeps, callbackOnce, LinearCallback, SetupPage } from "./SetupPage.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from hub-app/index.html");

// One of each for the page's life: their identity is what the screens' effects depend on.
const onboarding = createOnboardingApi();
const setupDeps = browserSetupDeps((origin) => ownerSetupApi(origin, window.location.origin));
// Linear's one-time code arrives in this address; it is handed out once for the page's life and removed from
// the address bar, so remounting the callback page ("Refresh page data") never sends it again.
const takeCallback = callbackOnce(() => window.location, (path) => window.history.replaceState(null, "", path));

mountHub(container, {
  brand: { name: BRAND.name, logo: BRAND.logo },
  ownerView: (connection) => <OwnerFactory {...connection} />,
  setup: (identity, view) => view === "linearCallback"
    ? <LinearCallback identity={identity} deps={setupDeps} take={takeCallback} />
    : <SetupPage identity={identity} deps={setupDeps} />,
  onboarding: (identity) => <AdminOnboarding api={onboarding} identity={identity} />,
});
