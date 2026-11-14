import { useCallback, useEffect, useMemo, useState } from "react";
import type { LogEvent } from "@ladybug/shared";
import { api } from "./api";
import type { EventFilter } from "./api";

function matches(event: LogEvent, filter: EventFilter) {
  if (filter.types?.length && !filter.types.includes(event.type)) return false;
  if (filter.verdict && event.verdict !== filter.verdict) return false;
  if (filter.q) {
    const haystack = `${event.message} ${event.url ?? ""} ${event.host ?? ""}`.toLowerCase();
    if (!filter.q.toLowerCase().split(/\s+/).every((word) => haystack.includes(word))) return false;
  }
  return true;
}

type FeedState = {
  /** The filter these results are for. */
  key: string;
  items: LogEvent[];
  found: number;
  page: number;
  /** Live events newer than this are merged in on top. */
  since: number;
  error: string | null;
};

/**
 * Events from the activity log (searched in Typesense), with live events that
 * match the filter merged in on top.
 */
export function useEventFeed(filter: EventFilter, live: LogEvent[], perPage: number) {
  const key = JSON.stringify(filter);
  const [state, setState] = useState<FeedState>({
    key: "",
    items: [],
    found: 0,
    page: 1,
    since: 0,
    error: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .events(JSON.parse(key) as EventFilter, 1, perPage)
      .then((result) => {
        if (cancelled) return;
        setState({ key, items: result.items, found: result.found, page: 1, since: Date.now(), error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState((current) => ({ ...current, key, error: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      cancelled = true;
    };
  }, [key, perPage]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const next = state.page + 1;
      const result = await api.events(JSON.parse(key) as EventFilter, next, perPage);
      setState((current) => ({ ...current, items: [...current.items, ...result.items], page: next }));
    } catch (e) {
      setState((current) => ({ ...current, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoadingMore(false);
    }
  }, [key, perPage, state.page]);

  const fresh = useMemo(() => {
    const parsed = JSON.parse(key) as EventFilter;
    return live.filter((event) => event.at >= state.since && matches(event, parsed));
  }, [live, state.since, key]);

  const events = useMemo(() => {
    const seen = new Set<string>();
    return [...fresh, ...state.items].filter((event) => !seen.has(event.id) && seen.add(event.id));
  }, [fresh, state.items]);

  return {
    events,
    found: state.found + fresh.length,
    hasMore: state.items.length < state.found,
    loading: state.key !== key || loadingMore,
    error: state.error,
    loadMore,
  };
}
