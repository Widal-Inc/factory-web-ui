// first: every module below may call a built-in older browsers lack (lib/builtins.ts)
import "../lib/builtins.ts";
// then: every module below may read browser storage as it loads
import "../lib/legacyStorage.ts";
import { BRAND } from "../../shared/brand.ts";
import { mountHub } from "./mount.tsx";
import { OwnerFactory } from "./OwnerFactory.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from hub-app/index.html");

// The name and logo come from the shared BRAND config; the setup and onboarding slots stay empty
// until the reviewed onboarding services are composed, and the pages then say they are unavailable.
mountHub(container, {
  brand: { name: BRAND.name, logo: BRAND.logo },
  ownerView: (connection) => <OwnerFactory {...connection} />,
});
