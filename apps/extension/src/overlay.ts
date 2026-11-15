// Run inside a flagged page with chrome.scripting.executeScript({ func }).
// Chrome serialises each function on its own, so they can't use imports or
// anything else from this module: keep them self-contained.
//
// The overlay is a closed shadow root in the page's top layer holding an
// iframe of warning.html, which blocks the page. The page can't reach into the iframe (it's the
// extension's origin), and if it removes the overlay, it's put straight back.
// A page that keeps removing it is reported, and the background worker
// replaces the whole page with the warning instead.

/** Covers the page with the warning in `frameUrl`. Replaces any earlier one. */
export function mountOverlay(frameUrl: string, token: string) {
  type Mounted = { dispose: () => void };
  const scope = globalThis as typeof globalThis & { __computerbugWarning?: Mounted };
  scope.__computerbugWarning?.dispose();

  const host = document.createElement("computerbug-warning");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  // Shadow-root !important beats the page's own !important rules for the host.
  style.textContent = `
    :host {
      all: initial !important;
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      display: block !important;
      z-index: 2147483647 !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      /* The blocked page's brown, so none of the page shows while it loads. */
      background: #4a2d1e !important;
      animation: computerbug-in 0.18s ease-out;
    }
    @media (prefers-color-scheme: dark) {
      :host { background: #21150e !important; }
    }
    iframe {
      all: initial;
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      /* Matches the warning page, so Chrome doesn't paint the frame white while it loads. */
      color-scheme: light dark;
    }
    @keyframes computerbug-in {
      from { opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      :host { animation: none; }
    }
  `;
  const frame = document.createElement("iframe");
  frame.src = frameUrl;
  frame.title = "Computerbug warning";
  frame.addEventListener("load", () => frame.focus());
  root.append(style, frame);
  // The top layer sits above anything the page stacks, whatever its z-index.
  host.setAttribute("popover", "manual");

  const lockScroll = (element: HTMLElement | null) => {
    if (!element) return () => {};
    const previous = element.style.getPropertyValue("overflow");
    const priority = element.style.getPropertyPriority("overflow");
    element.style.setProperty("overflow", "hidden", "important");
    return () => element.style.setProperty("overflow", previous, priority);
  };
  let unlock = () => {};
  /** Times the page took the overlay away. Each one reloads the frame. */
  let removals = 0;

  const attach = () => {
    const parent = document.documentElement;
    if (!parent) return;
    if (!host.isConnected || host.parentNode !== parent) {
      parent.append(host);
      unlock();
      unlock = lockScroll(parent);
    }
    try {
      if (!host.matches(":popover-open")) host.showPopover();
    } catch {
      // No popover support: the z-index has to do.
    }
  };

  // Put the overlay back if the page removes it, or replaces the whole document element.
  const observer = new MutationObserver(() => {
    if (!host.isConnected) {
      if (++removals > 2) {
        observer.disconnect();
        void chrome.runtime.sendMessage({ type: "warning:tampered", token }).catch(() => {});
        return;
      }
      attach();
    }
    if (document.documentElement) observer.observe(document.documentElement, { childList: true });
  });
  observer.observe(document, { childList: true });
  if (document.documentElement) observer.observe(document.documentElement, { childList: true });
  attach();

  scope.__computerbugWarning = {
    dispose: () => {
      observer.disconnect();
      host.remove();
      unlock();
      delete scope.__computerbugWarning;
    },
  };
}

/** Takes the overlay off the page ("Continue anyway"). */
export function unmountOverlay() {
  const scope = globalThis as typeof globalThis & { __computerbugWarning?: { dispose: () => void } };
  scope.__computerbugWarning?.dispose();
}
