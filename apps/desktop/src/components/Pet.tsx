import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { fetchGreeting } from "../api";
import type { OverlayLayout } from "../ladybug-api";
import { LadybugRenderer } from "./ladybug/LadybugRenderer";
import "./Pet.css";

// Hit box, roughly the ladybug's silhouette. Its bottom edge is the ground line.
const PET_WIDTH = 92;
const PET_HEIGHT = 60;
// The 3D canvas is larger than the hit box so wings, legs and the shadow have
// room; it is centred horizontally and sits GROUND_PX below the ground line.
const UNIT_PX = 100; // CSS px per model unit (≈ the bug's length)
const CANVAS_WIDTH = 180;
const CANVAS_HEIGHT = 150;
const GROUND_PX = 14;
const GRAVITY = 2400; // px/s²
const WALK_SPEED = 70; // px/s
const BOUNCE = 0.35;
const GROUND_FRICTION = 6; // 1/s, damps sliding after a throw
const HOP_VELOCITY = -650; // px/s
const CLICK_SLOP = 4; // px of movement before a press becomes a drag
const BUBBLE_MS = 3500;
const OFFLINE_MESSAGE = "Can't reach the server…";

type Mode = "idle" | "walking" | "airborne" | "dragging";

type PhysicsState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: 1 | -1;
  mode: Mode;
  targetX: number;
  idleUntil: number;
};

type DragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
  lastX: number;
  lastY: number;
  lastT: number;
};

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

export default function Pet({ layout }: { layout: OverlayLayout }) {
  const petRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const layoutRef = useRef(layout);
  const stateRef = useRef<PhysicsState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // Bounds the pet can move within: the work area, so it sits on the dock/taskbar.
  const getBounds = () => {
    const { workArea } = layoutRef.current;
    return {
      minX: workArea.x,
      maxX: workArea.x + workArea.width - PET_WIDTH,
      minY: workArea.y,
      groundY: workArea.y + workArea.height - PET_HEIGHT,
    };
  };

  // Physics / behaviour loop. Writes directly to the DOM to avoid re-rendering every frame.
  useEffect(() => {
    if (!stateRef.current) {
      const { minX, maxX, groundY } = getBounds();
      const x = randomBetween(minX, maxX);
      stateRef.current = {
        x,
        y: groundY - 300,
        vx: 0,
        vy: 0,
        heading: 1,
        mode: "airborne",
        targetX: x,
        idleUntil: 0,
      };
    }

    const ladybug = new LadybugRenderer(canvasRef.current!, {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      unitPx: UNIT_PX,
      groundPx: GROUND_PX,
    });

    let frame = 0;
    let last = performance.now();
    let prevX = stateRef.current.x;

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      const s = stateRef.current!;
      const { minX, maxX, minY, groundY } = getBounds();

      switch (s.mode) {
        case "idle":
          s.y = groundY;
          if (now >= s.idleUntil) {
            s.targetX = randomBetween(minX, maxX);
            s.heading = s.targetX >= s.x ? 1 : -1;
            s.mode = "walking";
          }
          break;

        case "walking": {
          s.y = groundY;
          const dx = s.targetX - s.x;
          s.x += Math.sign(dx) * Math.min(Math.abs(dx), WALK_SPEED * dt);
          if (Math.abs(dx) < 1) {
            s.mode = "idle";
            s.idleUntil = now + randomBetween(1500, 6000);
          }
          break;
        }

        case "airborne": {
          s.vy += GRAVITY * dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          if (Math.abs(s.vx) > 60) s.heading = s.vx > 0 ? 1 : -1;

          if (s.x < minX || s.x > maxX) {
            s.x = Math.min(Math.max(s.x, minX), maxX);
            s.vx *= -BOUNCE;
          }
          if (s.y < minY) {
            s.y = minY;
            s.vy = Math.abs(s.vy) * BOUNCE;
          }
          if (s.y >= groundY) {
            s.y = groundY;
            if (s.vy > 200) ladybug.land(s.vy);
            s.vy = -s.vy * BOUNCE;
            s.vx *= 1 - Math.min(1, GROUND_FRICTION * dt);
            if (Math.abs(s.vy) < 120) {
              s.vy = 0;
              s.vx = 0;
              s.mode = "idle";
              s.idleUntil = now + randomBetween(800, 2500);
            }
          }
          break;
        }

        case "dragging":
          break;
      }

      if (petRef.current) {
        petRef.current.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`;
      }
      // On-screen velocity, so drags (which move x outside this loop) count too.
      const vx = dt > 0 ? (s.x - prevX) / dt : 0;
      prevX = s.x;
      if (s.mode === "dragging" && Math.abs(vx) > 120) s.heading = vx > 0 ? 1 : -1;
      ladybug.render({ mode: s.mode, vx, heading: s.heading }, dt);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      ladybug.dispose();
    };
  }, []);

  // Hide the speech bubble after a moment.
  useEffect(() => {
    if (!bubble) return;
    const timeout = setTimeout(() => setBubble(null), BUBBLE_MS);
    return () => clearTimeout(timeout);
  }, [bubble]);

  const isPointInPet = (clientX: number, clientY: number) => {
    const rect = petRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  };

  const onPointerEnter = () => window.ladybug.setClickThrough(false);

  const onPointerLeave = () => {
    if (!dragRef.current) window.ladybug.setClickThrough(true);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const s = stateRef.current!;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - s.x,
      offsetY: e.clientY - s.y,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      lastX: e.clientX,
      lastY: e.clientY,
      lastT: performance.now(),
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const s = stateRef.current!;

    if (!drag.moved) {
      const distance = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (distance < CLICK_SLOP) return;
      drag.moved = true;
      s.mode = "dragging";
      setDragging(true);
    }

    const { minX, maxX, minY, groundY } = getBounds();
    const now = performance.now();
    const dt = Math.max((now - drag.lastT) / 1000, 1 / 240);
    s.vx = (e.clientX - drag.lastX) / dt;
    s.vy = (e.clientY - drag.lastY) / dt;
    s.x = Math.min(Math.max(e.clientX - drag.offsetX, minX), maxX);
    s.y = Math.min(Math.max(e.clientY - drag.offsetY, minY), groundY);
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.lastT = now;
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const s = stateRef.current!;

    if (drag.moved) {
      // Throw: keep the release velocity, capped so it stays on screen-ish.
      s.vx = Math.max(-2500, Math.min(2500, s.vx));
      s.vy = Math.max(-2500, Math.min(2500, s.vy));
      s.mode = "airborne";
      setDragging(false);
    } else {
      // Click: hop and say hi.
      if (s.mode !== "airborne") {
        s.vx = 0;
        s.vy = HOP_VELOCITY;
        s.mode = "airborne";
      }
      fetchGreeting()
        .then(setBubble)
        .catch(() => setBubble(OFFLINE_MESSAGE));
    }

    if (!isPointInPet(e.clientX, e.clientY)) window.ladybug.setClickThrough(true);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    window.ladybug.showMenu();
  };

  return (
    <div
      ref={petRef}
      className={dragging ? "pet dragging" : "pet"}
      style={{ width: PET_WIDTH, height: PET_HEIGHT }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
    >
      {bubble && <div className="pet-bubble">{bubble}</div>}
      <canvas
        ref={canvasRef}
        className="pet-canvas"
        style={{
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          left: (PET_WIDTH - CANVAS_WIDTH) / 2,
          top: PET_HEIGHT + GROUND_PX - CANVAS_HEIGHT,
        }}
      />
    </div>
  );
}
