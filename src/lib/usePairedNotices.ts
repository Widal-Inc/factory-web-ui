import { useCallback, useState } from "react";
import type { DevicePairedEvent, DeviceRemovedEvent } from "../../shared/machines.ts";

/** Enrollments this window was told of and has not dismissed (components/DevicePairedNotice.tsx). */
export function usePairedNotices() {
  const [pairedNotices, setPairedNotices] = useState<readonly DevicePairedEvent[]>([]);
  /** devices removed from this PC while this window was open (components/DevicePairedNotice.tsx, DeviceRemovedNotice) */
  const [removedNotices, setRemovedNotices] = useState<readonly DeviceRemovedEvent[]>([]);
  const dismissRemovedNotice = useCallback((event: DeviceRemovedEvent) => setRemovedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  const dismissPairedNotice = useCallback((event: DevicePairedEvent) => setPairedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  return { pairedNotices, setPairedNotices, dismissPairedNotice, removedNotices, setRemovedNotices, dismissRemovedNotice };
}
