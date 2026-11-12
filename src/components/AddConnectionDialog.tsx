import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, RefreshCw, X } from "lucide-react";

import "./AddConnectionDialog.css";

import { BRAND } from "../../shared/brand.ts";
import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { ApiError, findSshCandidates, type SshCandidate } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { PhonePanel } from "./PhonePanel.tsx";
import { SettingsQuery } from "./SettingsControls.tsx";

/** the sheet's ways, one tab each: PCs over SSH, and phones and browsers on this PC's address */
export type ConnectTab = "ssh" | "devices";

/** the dialog open on a phone: a touch screen, or a window as narrow as one */
const PHONE_QUERY = "(pointer: coarse), (max-width: 768px)";

/**
 * The tabs this window gets, in their order: only the ways it can use. SSH is offered where the page can add PCs.
 * Phones and devices is always there.
 */
export function connectTabs({ sshOffered }: { sshOffered: boolean }): ConnectTab[] {
  return [...(sshOffered ? ["ssh" as const] : []), "devices"];
}

export interface AddConnectionDialogProps {
  plan: PhonePlan;
  /** the Add PC dialog, its address filled in when a found PC was picked; null where PCs are not added from here */
  onAddPc: ((preset?: AddPcPreset) => void) | null;
  /** the roster: which found PCs are added already, and the PCs saved in herdr that wait for Connect */
  machines: readonly Machine[];
  /** Connect on a PC saved in herdr: its own setup dialog */
  onConnectMachine: (machine: Machine) => void;
  onClose: () => void;
}

/**
 * Settings → Devices and PCs → Add a connection, as herdr's Add a machine: one tab per way, the PCs each way
 * finds listed with Add, and a field to type one. SSH lists the PCs saved in herdr, the hosts of this PC's ssh
 * config and its Tailscale login's other PCs, each opening Add PC with its address. Phones and devices holds
 * what a phone or browser opens this PC with: its Tailscale address.
 */
export function AddConnectionDialog({ plan, onAddPc, machines, onConnectMachine, onClose }: AddConnectionDialogProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); }, true, true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // gone from the page: its listener goes a moment later, and the key is Settings'
      if (surface.current === null) return;
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return;
      // a confirmation opened over this dialog takes its own Escape
      if (document.querySelector('[role="alertdialog"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);

  const phone = useMediaQuery(PHONE_QUERY);
  const tabs = connectTabs({ sshOffered: onAddPc !== null });
  // a phone mostly connects itself; a PC's window opens on the PCs
  const [chosen, setChosen] = useState<ConnectTab>(() => (phone && tabs.includes("devices") ? "devices" : tabs[0]!));
  const tab = tabs.includes(chosen) ? chosen : tabs[0]!;
  // a tab once opened stays mounted while the dialog is: going back to a tab keeps what it showed
  const opened = useRef(new Set<ConnectTab>());
  opened.current.add(tab);
  const label: Record<ConnectTab, string> = { ssh: "SSH", devices: t("Phones and devices") };

  return createPortal(
    // a Settings search hides no row in here
    <SettingsQuery.Provider value={[]}>
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal connect-phone-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Add a connection")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body connect-phone-body">
          {tabs.length > 1 && (
            <div className="segmented connect-tabs" role="group" aria-label={t("How to connect")}>
              {tabs.map((way) => <button key={way} type="button" aria-pressed={tab === way} data-tab={way} onClick={() => setChosen(way)}>{label[way]}</button>)}
            </div>
          )}
          {opened.current.has("ssh") && tabs.includes("ssh") && (
            <div className="connect-tab" data-tab-panel="ssh" hidden={tab !== "ssh"}>
              <SshTab machines={machines} onAddPc={onAddPc!} onConnectMachine={onConnectMachine} />
            </div>
          )}
          {opened.current.has("devices") && (
            <div className="connect-tab" data-tab-panel="devices" hidden={tab !== "devices"}>
              <DevicesTab plan={plan} phone={phone} />
            </div>
          )}
        </div>
      </div>
    </div>
    </SettingsQuery.Provider>,
    document.body,
  );
}

/** how a found PC is known here: saved in herdr, a host of the ssh config, or a PC of the Tailscale login */
type FoundSource = "herdr" | SshCandidate["source"];
const SOURCE_LABEL: Record<FoundSource, string> = { herdr: "herdr", ssh_config: "ssh config", tailscale: "Tailscale" };

/**
 * SSH: the PCs found, each with Connect (saved in herdr, its own dialog), Add (Add PC with its address) or Added,
 * then a field for any other address. A window the server will not tell gets the field alone.
 */
export function SshTab({ machines, onAddPc, onConnectMachine }: { machines: readonly Machine[]; onAddPc: (preset?: AddPcPreset) => void; onConnectMachine: (machine: Machine) => void }) {
  const t = useT();
  const [found, setFound] = useState<SshCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reads, setReads] = useState(0);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    let live = true;
    setFailed(false);
    findSshCandidates().then(({ pcs }) => { if (live) setFound(pcs); }, (error: unknown) => {
      // a window the server will not tell (owner_only) gets the field alone; anything else says so, with Try again
      const refused = error instanceof ApiError && error.code === "owner_only";
      if (!refused) console.warn(`${BRAND.name}: the PCs to add over SSH could not be read`, error instanceof Error ? error.name : error);
      if (!live) return;
      setFound([]);
      setFailed(!refused);
    });
    return () => { live = false; };
  }, [reads]);
  const saved = machines.filter((machine) => machine.herdr_profile_id !== undefined && machine.action_required === "connect");
  // a found PC is Added only as Add would add it: its own address, on ssh's default port and herdr's default session
  const added = (destination: string) => machines.some(({ target }) => target?.destination === destination && (target.port ?? 22) === 22 && target.session === undefined);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const destination = typed.trim();
    if (destination !== "") onAddPc({ destination });
  };
  const row = (key: string, name: string, detail: string | null, source: FoundSource, action: ReactNode) => (
    <li key={key} className="connect-found-row">
      <span className="connect-found-name">{name}</span>
      {detail !== null && <span className="connect-found-detail">{detail}</span>}
      <span className="connect-found-source">{SOURCE_LABEL[source]}</span>
      {action}
    </li>
  );
  return (
    <>
      <p className="settings-description">{t("Add another PC over SSH.")}</p>
      {found === null ? <p className="settings-hint" role="status">{t("Looking for PCs…")}</p> : (saved.length > 0 || found.length > 0) && (
        <div className="connect-found">
          <ul className="connect-found-list">
            {saved.map((machine) => row(`herdr:${machine.id}`, machine.name, machine.target?.destination ?? null, "herdr",
              <button type="button" className="btn" onClick={() => onConnectMachine(machine)}>{t("Connect")}</button>))}
            {found.map((pc) => row(`${pc.source}:${pc.destination}`, pc.name, pc.detail, pc.source, added(pc.destination)
              ? <span className="connect-found-added"><Check aria-hidden="true" />{t("Added")}</span>
              : <button type="button" className="btn" aria-label={t("Add {name}", { name: pc.name })} onClick={() => onAddPc({ destination: pc.destination, name: pc.name })}>{t("Add")}</button>))}
          </ul>
        </div>
      )}
      {failed && (
        <div className="connect-found-failed" role="alert">
          <p className="settings-hint">{t("The PCs this PC knows could not be read.")}</p>
          <button type="button" className="btn" onClick={() => { setFound(null); setReads((count) => count + 1); }}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      <form className="connect-ssh-form" onSubmit={add}>
        <label className="settings-label" htmlFor="connect-ssh-address">{t("Or type an SSH address")}</label>
        <div className="connect-ssh-field">
          <input id="connect-ssh-address" className="input" type="text" value={typed} placeholder="user@host" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setTyped(event.target.value)} />
          <button type="submit" className="btn" disabled={typed.trim() === ""}>{t("Add")}</button>
        </div>
      </form>
    </>
  );
}

/**
 * Phones and devices: this PC's Tailscale address once it has one. A way this PC cannot use is left out,
 * not explained.
 */
function DevicesTab({ plan, phone }: { plan: PhonePlan; phone: boolean }) {
  const t = useT();
  if (plan.kind !== "here" && plan.kind !== "served") return <p className="settings-description">{t("Open Ovis on the PC itself to add a connection.")}</p>;
  return (
    <section className="connect-section" aria-label="Tailscale">
      <p className="settings-label">Tailscale</p>
      <PhonePanel url={plan.url} phone={phone} />
    </section>
  );
}
