import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(path: string) {
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  window.scrollTo(0, 0);
  for (const listener of listeners) listener();
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export type Route = { name: "home" } | { name: "demo" } | { name: "scan"; scanId: string } | { name: "not_found" };

export function matchRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/demo" || path === "/scans/demo") return { name: "demo" };
  const scan = /^\/scans\/([^/]+)$/.exec(path);
  if (scan) return { name: "scan", scanId: decodeURIComponent(scan[1]) };
  return { name: "not_found" };
}
