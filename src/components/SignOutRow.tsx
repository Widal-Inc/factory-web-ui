import { useState } from "react";

import { useT } from "../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SettingsRow } from "./SettingsControls.tsx";

/** Settings → Devices and PCs → Sign out: forget this browser's sign-in, after asking once. */
export function SignOutRow({ onSignOut, label }: { onSignOut: () => Promise<void>; /** the row's and its button's name, beside another Sign out on the page */ label?: string }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <SettingsRow label={label ?? t("Sign out")} description={t("Forget this browser's sign-in. Getting back in takes the access token.")}>
        <button type="button" className="btn" onClick={() => setConfirming(true)}>{label ?? t("Sign out")}</button>
      </SettingsRow>
      {confirming && <ConfirmDialog title={t("Sign out of this browser?")} body={t("Getting back in takes the access token.")} confirmLabel={t("Sign out")} onClose={() => setConfirming(false)} onConfirm={onSignOut} />}
    </>
  );
}
