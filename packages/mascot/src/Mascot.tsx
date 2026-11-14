import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import { MASCOT_ASPECT, UNITS_HIGH, UNITS_WIDE } from "./aspect.ts";
import { LadybugRenderer } from "./LadybugRenderer.ts";
import type { LadybugMood, LadybugPose, LadybugViewport } from "./LadybugRenderer.ts";

/** The leaf's centre, up from the bottom of the canvas. */
const GROUND_UNITS = 0.3;
/** Longest frame step, so a stalled tab doesn't fling the bug. */
const MAX_DT = 0.05;
/** With reduced motion, frames stop this long after anything changes. */
const SETTLE_MS = 1600;

export type MascotHandle = {
  /** Hop and spin, for good news. */
  celebrate: () => void;
  /** Wings flare and the shell flashes red. */
  alarm: () => void;
  /** A quick shiver. */
  startle: () => void;
  hop: () => void;
};

export type MascotLook = { x: number; y: number };

type Props = {
  mood?: LadybugMood;
  /**
   * What to look at: a direction (-1..1, x right and y down), "pointer" to
   * follow the cursor, or null to glance around.
   */
  look?: MascotLook | "pointer" | null;
  className?: string;
  style?: CSSProperties;
  /** Shown instead when WebGL isn't available. */
  fallback?: ReactNode;
  ref?: Ref<MascotHandle>;
};

function viewportFor(box: HTMLElement): LadybugViewport {
  const width = Math.max(1, box.clientWidth);
  const height = Math.max(1, box.clientHeight || width / MASCOT_ASPECT);
  const unitPx = Math.min(width / UNITS_WIDE, height / UNITS_HIGH);
  return { width, height, unitPx, groundPx: GROUND_UNITS * unitPx };
}

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/**
 * The desktop pet's 3D ladybug, standing on a leaf. It sizes itself to its
 * CSS box (keep the aspect at MASCOT_ASPECT) and is decorative: put anything
 * it "says" in real text next to it.
 */
export default function Mascot({ mood = "calm", look = "pointer", className, style, fallback, ref }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<LadybugRenderer | null>(null);
  const poseRef = useRef<LadybugPose>({ mode: "idle", vx: 0, heading: 1, mood, look: null });
  const pointerRef = useRef<MascotLook | null>(null);
  const lookRef = useRef(look);
  const wakeRef = useRef<() => void>(() => {});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    poseRef.current.mood = mood;
    lookRef.current = look;
    wakeRef.current();
  }, [mood, look]);

  useImperativeHandle(ref, () => {
    const act = (fn: (renderer: LadybugRenderer) => void) => () => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      fn(renderer);
      wakeRef.current();
    };
    return {
      celebrate: act((r) => {
        r.hop();
        r.celebrate(Math.random() < 0.5 ? 1 : -1);
      }),
      alarm: act((r) => r.alarm()),
      startle: act((r) => r.startle()),
      hop: act((r) => r.hop()),
    };
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // A canvas of our own per mount: a remount (StrictMode, or a fast route
    // change) must not inherit the last renderer's WebGL context and state.
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%";
    box.append(canvas);
    let renderer: LadybugRenderer;
    try {
      renderer = new LadybugRenderer(canvas, viewportFor(box), { perch: true });
    } catch {
      // No WebGL (old GPU, or blocked): show the fallback instead.
      canvas.remove();
      const timer = setTimeout(() => setFailed(true));
      return () => clearTimeout(timer);
    }
    rendererRef.current = renderer;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const light = () => {
      renderer.setLighting(dark.matches ? "night" : "day");
      wakeRef.current();
    };
    let awakeUntil = performance.now() + SETTLE_MS;
    let visible = true;
    let last = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      // The first frame's timestamp can predate `last`.
      const dt = Math.max(0, Math.min(MAX_DT, (now - last) / 1000));
      last = now;
      if (!visible || (reducedMotion.matches && now > awakeUntil)) return;
      const wanted = lookRef.current;
      const pose = poseRef.current;
      pose.look = wanted === "pointer" ? (reducedMotion.matches ? null : pointerRef.current) : wanted;
      renderer.render(pose, dt);
    };
    frame = requestAnimationFrame(tick);
    wakeRef.current = () => {
      awakeUntil = performance.now() + SETTLE_MS;
    };
    light();
    dark.addEventListener("change", light);

    const resize = new ResizeObserver(() => {
      renderer.resize(viewportFor(box));
      wakeRef.current();
    });
    resize.observe(box);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    intersection.observe(box);

    const onPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = {
        x: clamp((event.clientX - (rect.left + rect.width / 2)) / (window.innerWidth / 2)),
        y: clamp((event.clientY - (rect.top + rect.height * 0.55)) / (window.innerHeight / 2)),
      };
    };
    const onLeave = () => {
      pointerRef.current = null;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      window.removeEventListener("pointermove", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      dark.removeEventListener("change", light);
      wakeRef.current = () => {};
      rendererRef.current = null;
      renderer.dispose({ loseContext: true });
      canvas.remove();
    };
  }, []);

  if (failed) return <>{fallback ?? null}</>;
  return (
    <div
      ref={boxRef}
      className={className}
      style={{ width: "100%", aspectRatio: `${UNITS_WIDE} / ${UNITS_HIGH}`, ...style }}
      aria-hidden="true"
    />
  );
}
