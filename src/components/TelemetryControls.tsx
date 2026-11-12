import { useEffect, useRef, useState } from "react";
import { ChartColumn, X } from "lucide-react";

import { NOTICE_VERSION, type TelemetryStatus } from "../../shared/telemetry.ts";
import { ApiError, changeTelemetry, fetchTelemetry } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

/**
 * The one-time line about the version and crash reports (shared/telemetry.ts). Showing it is what
 * lets the server send, so it is recorded once it has been painted in a visible tab, and the server
 * still waits a while before the first message so the switch behind What is sent stops it. It stays
 * one line on any width: its text opens Settings, which says what is sent in full, and Turn off is
 * the switch's off in one tap. Closing it only hides it in this tab.
 */
export function TelemetryNotice({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [closed, setClosed] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [offFailed, setOffFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchTelemetry().then((current) => {
      if (!live || !current) return;
      if (!current.notice_seen && current.enabled && !current.blocked_by_env) setShown(true);
    }, (error: unknown) => console.error("telemetry status", error));
    return () => { live = false; };
  }, [enabled]);
  useEffect(() => {
    if (!shown) return;
    let recorded = false;
    let frame = 0;
    // two frames after the commit the line has been painted; a hidden tab paints nothing
    const afterPaint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(record); });
    };
    const record = () => {
      if (recorded || document.visibilityState !== "visible") return;
      recorded = true;
      changeTelemetry({ notice_seen: true, notice_version: NOTICE_VERSION }).catch((error: unknown) => console.error("telemetry notice", error));
    };
    const onVisibility = () => { if (document.visibilityState === "visible") afterPaint(); };
    afterPaint();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { recorded = true; cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", onVisibility); };
  }, [shown]);
  if (!shown || closed) return null;
  const turnOff = () => {
    setTurningOff(true);
    setOffFailed(false);
    // a refusal brings the line back, even after a close, and says so: the off is never taken for granted
    changeTelemetry({ enabled: false }).then(() => setClosed(true), (error: unknown) => {
      console.error("telemetry off", error);
      setTurningOff(false);
      setOffFailed(true);
      setClosed(false);
    });
  };
  const text = offFailed ? t("Couldn't turn the reports off. Open Settings to use the switch.") : t("Widal Factory reports its version, and any crash, to improve it.");
  return <div className="update-notice is-line is-telemetry" role={offFailed ? "alert" : "status"}>
    <button type="button" className="update-notice-text" title={text} aria-haspopup="dialog" onClick={() => { setClosed(true); onOpen(); }}>{text}</button>
    <button type="button" className="btn btn-ghost" disabled={turningOff} onClick={turnOff}>{t("Turn off")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => setClosed(true)}><X /></button>
  </div>;
}

/** Settings → About: the switch and the messages as they would be sent. Hidden on a server that sends none. */
export function TelemetryControls() {
  const t = useT();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const statusRequest = useRef(0);
  useEffect(() => {
    let live = true;
    const request = ++statusRequest.current;
    setError(null);
    // The GET keeps controls hidden on bridges and the demo, where telemetry is absent.
    fetchTelemetry().then((current) => {
      if (!live || request !== statusRequest.current) return;
      setStatus(current);
    }).catch((failure: unknown) => {
      if (!live || request !== statusRequest.current) return;
      if (failure instanceof ApiError && failure.status === 404) {
        setStatus(null);
        setError(null);
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    });
    return () => { live = false; };
  }, []);
  if (!status) return error ? <p className="settings-item settings-hint" role="alert">{error}</p> : null;
  const toggle = (enabled: boolean) => {
    // one change at a time: two answers out of order would leave the switch showing what the server does not hold
    if (saving) return;
    const request = ++statusRequest.current;
    setSaving(true);
    setError(null);
    changeTelemetry({ enabled }).then(
      (next) => { if (request === statusRequest.current) setStatus(next); },
      (failure: unknown) => { if (request === statusRequest.current) setError(failure instanceof Error ? failure.message : String(failure)); },
    ).finally(() => setSaving(false));
  };
  return (
    <SettingsGroup title={t("Version and crash reports")} className="settings-telemetry" section="telemetry">
      {status.blocked_by_env
        ? <p className="settings-item settings-hint">{t("Turned off on this PC by OVIS_TELEMETRY=0, DO_NOT_TRACK or a CI environment.")}</p>
        : <SettingsRow label={t("Send version and crash reports")} icon={ChartColumn} description={t("Once for each version this PC runs, and once after a crash, only the version number and a fixed kind of error. Nothing identifies this PC or you, and no settings, usage, error text, terminal content or files are sent. Nothing is sent before you have seen the notice.")}>
          <Toggle label={t("Send version and crash reports")} checked={status.enabled} onChange={toggle} disabled={saving} />
        </SettingsRow>}
      {error && <p className="settings-item settings-hint" role="alert">{error}</p>}
      <details className="settings-item">
        <summary>{t("What is sent")}</summary>
        {status.next.length > 0
          ? <pre className="update-output">{JSON.stringify(status.next, null, 2)}</pre>
          : <p className="settings-hint">{t("This version has already been reported. The next report is sent after an update or a crash.")}</p>}
        <p className="settings-hint">{t("After a crash, the next start sends one more message with the version and one of these kinds:")}</p>
        <pre className="update-output">{JSON.stringify(status.error_kinds, null, 2)}</pre>
        <p className="settings-hint">{t("The server that receives these sees this PC's network address, as any server does; the messages do not carry it.")}</p>
      </details>
    </SettingsGroup>
  );
}
