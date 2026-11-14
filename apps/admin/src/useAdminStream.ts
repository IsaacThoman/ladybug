import { useEffect, useRef, useState } from "react";
import type { AdminStreamEvent, LogEvent, PendingAnalysis } from "@ladybug/shared";

/** Live activity from the server: new log events and running analyses. */
export function useAdminStream(onEvent: (event: LogEvent) => void) {
  const [pending, setPending] = useState<PendingAnalysis[]>([]);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const source = new EventSource("/api/admin/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message: MessageEvent<string>) => {
      const data = JSON.parse(message.data) as AdminStreamEvent;
      if (data.kind === "pending") setPending(data.pending);
      else onEventRef.current(data.event);
    };
    return () => source.close();
  }, []);

  return { pending, connected };
}

/** Re-renders every `intervalMs`, for countdowns and "2m ago" labels. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
