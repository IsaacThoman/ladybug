import { useEffect } from "react";

/** Report clickable surfaces for the main process's cursor polling, including OS drags. */
export function useOverlayPointer() {
  useEffect(() => {
    let last = "";
    let frame = 0;
    const tick = () => {
      const rects = [...document.querySelectorAll("[data-overlay-interactive]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const serialized = JSON.stringify(rects);
      if (last !== serialized) { last = serialized; window.ladybug.setInteractiveRects(rects); }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      window.ladybug.setInteractiveRects([]);
    };
  }, []);
}
