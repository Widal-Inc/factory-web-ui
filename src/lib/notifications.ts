import { BRAND } from "../../shared/brand.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { ENDED_NOTIFICATION_BODY, paneNotificationTag, statusNotificationBody } from "../../shared/notify-policy.ts";

/**
 * Tab alerts: Web Notifications for pane status transitions while this page is open
 * but hidden. A device with a push subscription (lib/push.ts) gets the same alerts from
 * the server instead, and App skips these. Notification exists only in secure contexts
 * (https or localhost) - a plain-http LAN deployment reports "unsupported", and the bell
 * there switches only the in-app alerts.
 *
 * The transition policy is shared with the server (shared/notify-policy.ts).
 */

export { alertPcAllowed, alertStatus, alertsAllow, paneAlertsMuted, shouldNotifyStatus } from "../../shared/notify-policy.ts";

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

export function notificationState(): NotificationState {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  const permission = await globalThis.Notification.requestPermission();
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Shown through the service worker when there is one: Android Chrome has no
 * `new Notification()`, and the worker's notificationclick (public/sw.js) selects the
 * pane. The constructor is the fallback for a page without a worker.
 */
async function show(paneId: string, title: string, body: string, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  if (typeof globalThis.Notification === "undefined") return;
  if (globalThis.Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return; // visible tab: the UI already shows it
  const tag = paneNotificationTag(paneId, machineId);
  const alertId = crypto.randomUUID();
  const options: NotificationOptions = { body, tag, data: { pane_id: paneId, machine_id: machineId, ...(workspaceId ? { workspace_id: workspaceId } : {}), alert_id: alertId }, icon: BRAND.icon };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration?.active) {
      // iOS keeps the pane's earlier alerts despite the tag: close them as a push does (public/sw.js),
      // only the ones up before this alert, so one shown meanwhile stays
      const listed = async (): Promise<Notification[]> => {
        try {
          return await registration.getNotifications({ tag });
        } catch {
          return []; // an older browser without getNotifications: the alert still shows
        }
      };
      const alertIdOf = (alert: Notification) => (alert.data as { alert_id?: string } | null)?.alert_id;
      const earlier = new Set((await listed()).map(alertIdOf));
      await registration.showNotification(title, options);
      for (const alert of earlier.size ? await listed() : []) {
        if (earlier.has(alertIdOf(alert))) alert.close();
      }
      return;
    }
    const notification = new globalThis.Notification(title, options);
    notification.addEventListener("click", () => {
      window.focus();
      onClick?.();
    });
  } catch {
    /* no way to show it here: the sidebar badge still carries the change */
  }
}

/** `workspaceId`: the pane's workspace, as the server's push names it (server/push.ts), so a tap after the pane ends opens it. */
export function showPaneStatusNotification(paneId: string, title: string, status: AgentStatus, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  return show(paneId, title, statusNotificationBody(status), onClick, machineId, workspaceId);
}

export function showPaneEndedNotification(paneId: string, title: string, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  return show(paneId, title, ENDED_NOTIFICATION_BODY, onClick, machineId, workspaceId);
}
