import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import type { LadybugMood, LadybugPose, LadybugRenderer, LadybugViewport } from "./ladybug/LadybugRenderer.ts";
import snapshot from "./ladybug.png";

export type LadybugHandle = {
  /** A hop and a happy spin. */
  celebrate: () => void;
  /** Wings flare and the shell flashes red. */
  alarm: () => void;
  /** Antennae go frantic for a moment. */
  startle: () => void;
};

type Props = {
  mood?: LadybugMood;
  /** CSS px per model unit, about the length of the bug's body. */
  size?: number;
  /** Pottering range: the bug strolls up to this many px either side of where it starts. */
  wander?: number;
  /** Usually a <SpeechBubble>. Floats above the bug and follows it around. */
  children?: ReactNode;
  className?: string;
  /** For placing the bug, e.g. `left` and `bottom` inside a positioned parent. */
  style?: CSSProperties;
  ref?: Ref<LadybugHandle>;
};

/** Canvas size and ground line, in model units. Same proportions as the desktop pet. */
const CANVAS_W = 1.8;
const CANVAS_H = 1.5;
const GROUND = 0.14;
/** Per model unit: walking speed (px/s), hop launch speed and gravity. */
const WALK = 0.62;
const HOP = 5.2;
const GRAVITY = 24;

/** Moods that hold still and face the viewer instead of strolling. */
const STILL_MOODS: ReadonlySet<LadybugMood> = new Set(["expectant", "happy", "alarmed"]);

const between = (min: number, max: number) => min + Math.random() * (max - min);
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

type Motion = {
  x: number;
  y: number;
  vy: number;
  heading: 1 | -1;
  walking: boolean;
  airborne: boolean;
  targetX: number;
  idleUntil: number;
};

/**
 * The 3D ladybug from the desktop pet, for web pages. three.js loads lazily,
 * the bug fades in once it's ready, and rendering pauses while it's off
 * screen or the tab is hidden. Falls back to a still snapshot without WebGL.
 */
export default function Ladybug({ mood = "calm", size = 100, wander = 0, children, className, style, ref }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LadybugRenderer | null>(null);
  const wakeRef = useRef<() => void>(() => {});
  const motion = useRef<Motion>({
    x: 0,
    y: 0,
    vy: 0,
    heading: 1,
    walking: false,
    airborne: false,
    targetX: 0,
    idleUntil: 0,
  });
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  const viewport: LadybugViewport = {
    width: Math.round(size * CANVAS_W),
    height: Math.round(size * CANVAS_H),
    unitPx: size,
    groundPx: Math.round(size * GROUND),
  };
  // Read inside the animation loop, which outlives any one render.
  const live = useRef({ mood, size, wander, viewport });
  useEffect(() => {
    live.current = { mood, size, wander, viewport };
    wakeRef.current();
  });

  useEffect(() => {
    rendererRef.current?.resize(live.current.viewport);
  }, [size]);

  useImperativeHandle(
    ref,
    () => ({
      celebrate() {
        const m = motion.current;
        if (!reducedMotion() && !m.airborne) {
          m.airborne = true;
          m.walking = false;
          m.vy = -HOP * live.current.size;
          rendererRef.current?.celebrate(m.heading);
        }
        wakeRef.current();
      },
      alarm() {
        rendererRef.current?.alarm();
        rendererRef.current?.startle();
        wakeRef.current();
      },
      startle() {
        rendererRef.current?.startle();
        wakeRef.current();
      },
    }),
    [],
  );

  useEffect(() => {
    const root = rootRef.current!;
    const canvas = canvasRef.current!;
    let renderer: LadybugRenderer | null = null;
    let disposed = false;
    let frame = 0;
    let last = 0;
    let onScreen = true;
    // With reduced motion the bug only animates briefly to settle into a new pose.
    const reduced = reducedMotion();
    let settleUntil = 0;
    motion.current.idleUntil = performance.now() + between(800, 2500);

    const step = (now: number, dt: number): LadybugPose => {
      const m = motion.current;
      const { mood, size, wander } = live.current;
      const still = reduced || wander <= 0 || STILL_MOODS.has(mood);
      let vx = 0;
      if (m.airborne) {
        m.vy += GRAVITY * size * dt;
        m.y += m.vy * dt;
        if (m.y >= 0) {
          renderer?.land(m.vy);
          m.y = 0;
          m.vy = 0;
          m.airborne = false;
          m.idleUntil = now + between(1500, 3000);
        }
      } else if (m.walking && still) {
        m.walking = false;
        m.idleUntil = now + 1500;
      } else if (m.walking) {
        const pace = mood === "sniffing" ? 0.45 : mood === "nervous" ? 0.35 : 1;
        const dx = m.targetX - m.x;
        const move = Math.sign(dx) * Math.min(Math.abs(dx), WALK * size * pace * dt);
        m.x += move;
        m.heading = dx >= 0 ? 1 : -1;
        vx = dt > 0 ? move / dt : 0;
        if (Math.abs(m.targetX - m.x) < 0.5) {
          m.walking = false;
          m.idleUntil = now + (mood === "sniffing" ? between(600, 1800) : between(2000, 5500));
        }
      } else if (!still && now > m.idleUntil) {
        // Somewhere new, not just a shuffle on the spot.
        let target = m.x;
        for (let i = 0; i < 6 && Math.abs(target - m.x) < wander * 0.4; i++) target = between(-wander, wander);
        m.targetX = target;
        m.walking = true;
      }
      // Wandered off and the range shrank (e.g. a smaller layout): head back.
      if (!m.walking && Math.abs(m.x) > wander && !still) {
        m.targetX = 0;
        m.walking = true;
      }
      bodyRef.current!.style.transform = `translate3d(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px, 0)`;
      return {
        mode: m.airborne ? "airborne" : m.walking ? "walking" : "idle",
        vx,
        heading: m.heading,
        mood,
      };
    };

    const running = () => onScreen && !document.hidden;
    const tick = (now: number) => {
      frame = 0;
      if (!renderer || !running()) return;
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      renderer.render(step(now, dt), dt);
      if (!reduced || now < settleUntil || motion.current.airborne) frame = requestAnimationFrame(tick);
    };
    const wake = () => {
      settleUntil = performance.now() + 1800;
      if (frame || !renderer || !running()) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      wake();
    });
    observer.observe(root);
    document.addEventListener("visibilitychange", wake);

    import("./ladybug/LadybugRenderer.ts").then(
      ({ LadybugRenderer }) => {
        if (disposed) return;
        try {
          renderer = new LadybugRenderer(canvas, live.current.viewport);
        } catch {
          setStatus("failed");
          return;
        }
        rendererRef.current = renderer;
        setStatus("ready");
        wake();
      },
      () => !disposed && setStatus("failed"),
    );

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", wake);
      wakeRef.current = () => {};
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, []);

  const rootStyle = {
    ...style,
    "--ladybug-unit": `${size}px`,
    "--ladybug-ground": `${viewport.groundPx}px`,
    width: viewport.width,
    height: viewport.height,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={className ? `ladybug ${className}` : "ladybug"}
      data-status={status}
      style={rootStyle}
    >
      <div ref={bodyRef} className="ladybug-body">
        <canvas
          ref={canvasRef}
          className="ladybug-canvas"
          style={{ width: viewport.width, height: viewport.height }}
          aria-hidden="true"
        />
        {status === "failed" && <img className="ladybug-fallback" src={snapshot} alt="" />}
        {children && <div className="ladybug-say">{children}</div>}
      </div>
    </div>
  );
}
