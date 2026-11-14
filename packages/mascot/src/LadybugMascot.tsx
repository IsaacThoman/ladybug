import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import { LadybugRenderer } from "./LadybugRenderer.ts";
import type { LadybugMode, LadybugMood } from "./LadybugRenderer.ts";

export type LadybugMascotHandle = {
  /** A little hop. */
  hop: () => void;
  /** A hop with a full happy spin. */
  celebrate: () => void;
  /** Wings flare and the shell flashes red. */
  alarm: () => void;
  /** Antennae go frantic for a moment. */
  startle: () => void;
};

type Props = {
  mood?: LadybugMood;
  /** Canvas size in CSS px. */
  width: number;
  height: number;
  /** CSS px per model unit, roughly the bug's length. */
  unitPx: number;
  /** Distance from the bottom of the canvas to where the feet rest. */
  groundPx?: number;
  /** Turn to look toward the pointer while idle. */
  followPointer?: boolean;
  /** Shown instead when WebGL isn't available. */
  fallback?: ReactNode;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<LadybugMascotHandle>;
};

const HOP_SECONDS = 0.5;
const HOP_HEIGHT = 0.38;
/** How far the bug turns toward a pointer at the edge of the window. */
const LOOK_RANGE = 0.65;

let webgl: boolean | undefined;
/** Whether this browser can draw WebGL at all, checked once. */
function webglAvailable() {
  if (webgl === undefined) {
    try {
      const context = document.createElement("canvas").getContext("webgl2");
      webgl = context !== null;
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * The 3D ladybug from the desktop pet, standing still on a page. Decorative:
 * it's hidden from assistive tech, so pair it with text that says the same.
 */
export default function LadybugMascot({
  mood = "calm",
  width,
  height,
  unitPx,
  groundPx = Math.round(height * 0.12),
  followPointer = false,
  fallback = null,
  className,
  style,
  ref,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LadybugRenderer | null>(null);
  const moodRef = useRef(mood);
  const lookRef = useRef<number | undefined>(undefined);
  /** Seconds into the current hop, or -1 when on the ground. */
  const hopRef = useRef(-1);
  const [failed, setFailed] = useState(() => !webglAvailable());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useImperativeHandle(ref, () => {
    const hop = () => {
      if (prefersReducedMotion() || hopRef.current >= 0) return false;
      hopRef.current = 0;
      return true;
    };
    return {
      hop: () => void hop(),
      celebrate: () => {
        if (hop()) rendererRef.current?.celebrate(Math.random() < 0.5 ? 1 : -1);
      },
      alarm: () => rendererRef.current?.alarm(),
      startle: () => rendererRef.current?.startle(),
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || failed) return;
    let renderer: LadybugRenderer;
    try {
      renderer = new LadybugRenderer(canvas, { width, height, unitPx, groundPx });
    } catch {
      // WebGL is there but wouldn't start (lost context, blocklisted GPU).
      queueMicrotask(() => setFailed(true));
      return;
    }
    rendererRef.current = renderer;

    let frame = 0;
    let last = performance.now();
    let visible = true;
    let first = true;

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      let mode: LadybugMode = "idle";
      let lift = 0;
      if (hopRef.current >= 0) {
        hopRef.current += dt;
        const p = hopRef.current / HOP_SECONDS;
        if (p >= 1) {
          hopRef.current = -1;
          renderer.land(900);
        } else {
          mode = "airborne";
          lift = 4 * p * (1 - p) * HOP_HEIGHT * unitPx;
        }
      }
      canvas.style.transform = lift ? `translateY(${-lift}px)` : "";
      renderer.render({ mode, vx: 0, heading: 1, mood: moodRef.current, look: lookRef.current }, dt);
      if (first) {
        first = false;
        setReady(true);
      }
      frame = visible ? requestAnimationFrame(tick) : 0;
    };

    // Stop drawing while scrolled out of view.
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !frame) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    });
    observer.observe(canvas);
    frame = requestAnimationFrame(tick);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [width, height, unitPx, groundPx, failed]);

  useEffect(() => {
    if (!followPointer) {
      lookRef.current = undefined;
      return;
    }
    const onMove = (event: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = event.clientX - (rect.left + rect.width / 2);
      const reach = Math.max(window.innerWidth / 2, 1);
      lookRef.current = Math.max(-1, Math.min(1, dx / reach)) * LOOK_RANGE;
    };
    const onLeave = () => (lookRef.current = undefined);
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [followPointer]);

  if (failed) return <>{fallback}</>;

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{
        width,
        height,
        display: "block",
        opacity: ready ? 1 : 0,
        transition: "opacity 0.4s ease",
        ...style,
      }}
    />
  );
}
