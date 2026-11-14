import { useEffect, useReducer } from "react";
import { SCAN_STATUSES, isTerminalStatus } from "@ladybug/shared";
import type { ScanEvent, ScanResponse } from "@ladybug/shared";
import { ApiRequestError, eventsUrl, getScan, isAbort } from "./api.ts";
import type { ApiFailure } from "./api.ts";
import { applyEvent, applyScan, emptyScan, isScanEvent } from "./scanState.ts";
import type { ScanState } from "./scanState.ts";

export type LiveConnection = "loading" | "streaming" | "polling" | "closed";

type LiveState = {
  scan: ScanState;
  connection: LiveConnection;
  failure: ApiFailure | null;
};

type Action =
  | { type: "scan"; scan: ScanResponse }
  | { type: "event"; event: ScanEvent; id: string }
  | { type: "connection"; connection: LiveConnection }
  | { type: "failure"; failure: ApiFailure | null };

function reducer(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "scan":
      return { ...state, scan: applyScan(state.scan, action.scan), failure: null };
    case "event":
      return { ...state, scan: applyEvent(state.scan, action.event, action.id) };
    case "connection":
      return { ...state, connection: action.connection };
    case "failure":
      return { ...state, failure: action.failure };
  }
}

const POLL_MS = 3000;
// The server may send plain `data:` messages or name each one with `event: <type>`; handle both.
const EVENT_NAMES = [
  "message",
  "status",
  "screenshot",
  "finding",
  "agent_note",
  "tool_call",
  "signal",
  "redirect_chain",
  "report",
] satisfies (ScanEvent["type"] | "message")[];

/** Mount under `key={scanId}`: state is not reset when the id changes. */
export function useLiveScan(scanId: string) {
  const [state, dispatch] = useReducer(reducer, scanId, (id) => ({
    scan: emptyScan(id),
    connection: "loading" as LiveConnection,
    failure: null,
  }));

  useEffect(() => {
    const abort = new AbortController();
    let source: EventSource | null = null;
    let pollTimer: number | undefined;
    let finished = false;
    const seen = new Set<string>();
    let anonymous = 0;

    const fail = (err: unknown) => {
      if (isAbort(err)) return;
      const failure: ApiFailure =
        err instanceof ApiRequestError ? err.failure : { kind: "http", status: 0, message: String(err) };
      dispatch({ type: "failure", failure });
    };

    const finish = async () => {
      if (finished) return;
      finished = true;
      source?.close();
      source = null;
      window.clearTimeout(pollTimer);
      dispatch({ type: "connection", connection: "closed" });
      // The final row lands slightly after the terminal event; retry briefly until the report is there.
      for (let attempt = 0; attempt < 5 && !abort.signal.aborted; attempt++) {
        try {
          const scan = await getScan(scanId, abort.signal);
          dispatch({ type: "scan", scan });
          if (scan.report || scan.status === "failed") return;
        } catch (err) {
          if (isAbort(err)) return;
        }
        await new Promise((r) => window.setTimeout(r, 800 * (attempt + 1)));
      }
    };

    const poll = () => {
      dispatch({ type: "connection", connection: "polling" });
      const tick = async () => {
        try {
          const scan = await getScan(scanId, abort.signal);
          dispatch({ type: "scan", scan });
          if (isTerminalStatus(scan.status)) {
            void finish();
            return;
          }
        } catch (err) {
          fail(err);
        }
        if (!abort.signal.aborted && !finished) pollTimer = window.setTimeout(tick, POLL_MS);
      };
      pollTimer = window.setTimeout(tick, POLL_MS);
    };

    const onMessage = (msg: MessageEvent<string>) => {
      const id = msg.lastEventId || `anon-${anonymous++}`;
      if (msg.lastEventId) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      let event: unknown;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!isScanEvent(event)) return;
      dispatch({ type: "event", event, id });
      if (event.type === "status" && SCAN_STATUSES.includes(event.status) && isTerminalStatus(event.status)) {
        void finish();
      }
    };

    const stream = () => {
      source = new EventSource(eventsUrl(scanId));
      for (const name of EVENT_NAMES) source.addEventListener(name, onMessage as EventListener);
      source.onopen = () => dispatch({ type: "connection", connection: "streaming" });
      source.onerror = () => {
        if (finished || !source) return;
        // CONNECTING means the browser is retrying with Last-Event-ID; CLOSED means it gave up.
        if (source.readyState === EventSource.CLOSED) {
          source = null;
          poll();
        }
      };
    };

    (async () => {
      try {
        const scan = await getScan(scanId, abort.signal);
        dispatch({ type: "scan", scan });
        if (isTerminalStatus(scan.status) && scan.report) {
          finished = true;
          dispatch({ type: "connection", connection: "closed" });
          return;
        }
        stream();
      } catch (err) {
        fail(err);
        dispatch({ type: "connection", connection: "closed" });
      }
    })();

    return () => {
      abort.abort();
      finished = true;
      source?.close();
      window.clearTimeout(pollTimer);
    };
  }, [scanId]);

  return state;
}
