import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { ScanEvent, ScanStatus, Verdict } from "@ladybug/shared";
import { createScan, fetchGreeting, getScan, OfflineError, reportUrl, watchScan } from "../api";
import type { OverlayLayout } from "../ladybug-api";
import { findHttpUrl, parseHttpUrl } from "../urls";
import { LadybugRenderer } from "./ladybug/LadybugRenderer";
import type { LadybugMood } from "./ladybug/LadybugRenderer";
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
const ALARM_JUMP_VELOCITY = -1000; // px/s
const CLICK_SLOP = 4; // px of movement before a press becomes a drag
const BUBBLE_MS = 3500;
const REACTION_MS = 30_000;
const ERROR_MS = 6000;
// Chromium repeats dragover while a drag hovers, even if the cursor is still.
// If they stop without a dragleave (the overlay went click-through mid-drag),
// the drag has left.
const DRAG_HOVER_STALE_MS = 400;
const OFFLINE_MESSAGE = "Can't reach the server…";
const NO_CLIPBOARD_URL_MESSAGE = "There's no link on the clipboard.";
const NOT_A_LINK_MESSAGE = "That's not a link I can check.";
const DROP_MESSAGE = "Drop a link!";

const STATUS_MESSAGES: Record<ScanStatus, string> = {
  queued: "sniffing around…",
  provisioning: "setting up a sandbox…",
  detonating: "opening the link…",
  investigating: "sniffing around…",
  scoring: "thinking it over…",
  done: "thinking it over…",
  failed: "thinking it over…",
};

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
  /** The next walk goes backwards, away from what the bug is facing. */
  backing: boolean;
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

type ScanState =
  | { phase: "idle" }
  /** `id` is null until the server accepts the scan. */
  | { phase: "scanning"; id: string | null; url: string; status: ScanStatus }
  | { phase: "done"; id: string; verdict: Verdict | "failed"; score: number | null }
  | { phase: "error"; message: string };

type Bubble = { text: string; tone?: "safe" | "warn" | "danger"; key: string };

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

function moodFor(scan: ScanState, dropHover: boolean): LadybugMood {
  if (dropHover) return "expectant";
  if (scan.phase === "scanning") return "sniffing";
  if (scan.phase !== "done") return "calm";
  if (scan.verdict === "benign") return "happy";
  if (scan.verdict === "suspicious") return "nervous";
  if (scan.verdict === "malicious") return "alarmed";
  return "calm";
}

function scanBubble(scan: ScanState): Bubble | null {
  switch (scan.phase) {
    case "idle":
      return null;
    case "scanning":
      return { text: STATUS_MESSAGES[scan.status], key: `status-${scan.status}` };
    case "error":
      return { text: scan.message, key: "error" };
    case "done":
      switch (scan.verdict) {
        case "benign":
          return { text: `Looks safe! (score ${scan.score})`, tone: "safe", key: "done" };
        case "suspicious":
          return { text: `Hmm, something's off… (${scan.score})`, tone: "warn", key: "done" };
        case "malicious":
          return { text: `Don't open that! (${scan.score})`, tone: "danger", key: "done" };
        case "failed":
          return { text: "I couldn't check that one.", key: "done" };
      }
  }
}

/** A short aside for live events worth reacting to, if any. */
function eventRemark(event: ScanEvent): string | null {
  if (event.type === "finding" && event.finding.severity === "high") return "uh oh…";
  if (event.type === "signal" && (event.signal.floor ?? 0) >= 70) return "uh oh…";
  if (event.type === "redirect_chain" && event.chain.length > 2) return "it keeps redirecting me…";
  return null;
}

/** First http(s) URL in a drop, trying the richest format first. */
function linkFromDrop(data: DataTransfer): string | null {
  const uris = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const uri of uris) {
    const url = parseHttpUrl(uri);
    if (url) return url;
  }
  const fromText = findHttpUrl(data.getData("text/plain"));
  if (fromText) return fromText;
  // text/x-moz-url is "url\ntitle".
  return parseHttpUrl(data.getData("text/x-moz-url").split(/\r?\n/)[0] ?? "");
}

const LINK_TYPES = ["text/uri-list", "text/plain", "text/x-moz-url"];
const carriesLink = (data: DataTransfer) => data.types.some((type) => LINK_TYPES.includes(type));
const dropEffectFor = (allowed: DataTransfer["effectAllowed"]): DataTransfer["dropEffect"] =>
  allowed === "link" || allowed === "linkMove" ? "link" : allowed === "move" ? "move" : "copy";

export default function Pet({ layout }: { layout: OverlayLayout }) {
  const petRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const layoutRef = useRef(layout);
  const stateRef = useRef<PhysicsState | null>(null);
  const ladybugRef = useRef<LadybugRenderer | null>(null);
  const moodRef = useRef<LadybugMood>("calm");
  /** Bumped per scan, so callbacks from a replaced scan are ignored. */
  const scanGenRef = useRef(0);
  const unwatchRef = useRef<(() => void) | null>(null);
  const lastDragOverRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [scan, setScan] = useState<ScanState>({ phase: "idle" });

  const mood = moodFor(scan, dropHover);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

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
        backing: false,
      };
    }

    const ladybug = new LadybugRenderer(canvasRef.current!, {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      unitPx: UNIT_PX,
      groundPx: GROUND_PX,
    });
    ladybugRef.current = ladybug;

    let frame = 0;
    let last = performance.now();
    let prevX = stateRef.current.x;
    let reportedX = Number.NaN;
    let reportedY = Number.NaN;

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      const s = stateRef.current!;
      const mood = moodRef.current;
      const { minX, maxX, minY, groundY } = getBounds();
      // Sniffing and nervous bugs potter about nearby instead of crossing the screen.
      const pottering = mood === "sniffing" || mood === "nervous";
      const speed = s.backing
        ? WALK_SPEED * 0.6
        : mood === "sniffing"
          ? WALK_SPEED * 0.45
          : mood === "nervous"
            ? WALK_SPEED * 0.35
            : WALK_SPEED;

      switch (s.mode) {
        case "idle":
          s.y = groundY;
          // Hold still while a link is dragged over it.
          if (mood === "expectant") s.idleUntil = Math.max(s.idleUntil, now + 300);
          if (now >= s.idleUntil) {
            if (s.backing) {
              s.targetX = s.x - s.heading * randomBetween(110, 180);
            } else if (pottering) {
              s.targetX = s.x + (Math.random() < 0.5 ? -1 : 1) * randomBetween(25, 140);
              s.heading = s.targetX >= s.x ? 1 : -1;
            } else {
              s.targetX = randomBetween(minX, maxX);
              s.heading = s.targetX >= s.x ? 1 : -1;
            }
            s.targetX = Math.min(Math.max(s.targetX, minX), maxX);
            s.mode = "walking";
          }
          break;

        case "walking": {
          s.y = groundY;
          if (mood === "expectant") {
            s.mode = "idle";
            s.idleUntil = now + 300;
            break;
          }
          const dx = s.targetX - s.x;
          s.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
          if (Math.abs(dx) < 1) {
            s.mode = "idle";
            s.backing = false;
            s.idleUntil = now + (pottering ? randomBetween(500, 1600) : randomBetween(1500, 6000));
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
              s.idleUntil = now + (s.backing ? randomBetween(300, 600) : randomBetween(800, 2500));
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
      // The main process hit-tests the cursor against this to toggle click-through.
      if (Math.abs(s.x - reportedX) >= 0.5 || Math.abs(s.y - reportedY) >= 0.5) {
        reportedX = s.x;
        reportedY = s.y;
        window.ladybug.setPetRect({ x: s.x, y: s.y, width: PET_WIDTH, height: PET_HEIGHT });
      }
      // On-screen velocity, so drags (which move x outside this loop) count too.
      const vx = dt > 0 ? (s.x - prevX) / dt : 0;
      prevX = s.x;
      if (s.mode === "dragging" && Math.abs(vx) > 120) s.heading = vx > 0 ? 1 : -1;
      ladybug.render({ mode: s.mode, vx, heading: s.heading, mood }, dt);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      ladybugRef.current = null;
      ladybug.dispose();
    };
  }, []);

  // Hide the speech bubble after a moment.
  useEffect(() => {
    if (!bubble) return;
    const timeout = setTimeout(() => setBubble(null), BUBBLE_MS);
    return () => clearTimeout(timeout);
  }, [bubble]);

  // Hold a verdict reaction (or an error) for a while, then calm down.
  useEffect(() => {
    if (scan.phase !== "done" && scan.phase !== "error") return;
    const timeout = setTimeout(
      () => setScan({ phase: "idle" }),
      scan.phase === "done" ? REACTION_MS : ERROR_MS,
    );
    return () => clearTimeout(timeout);
  }, [scan]);

  // Clear the drop cue if dragover events stop arriving.
  useEffect(() => {
    if (!dropHover) return;
    const interval = setInterval(() => {
      if (performance.now() - lastDragOverRef.current > DRAG_HOVER_STALE_MS) setDropHover(false);
    }, 100);
    return () => clearInterval(interval);
  }, [dropHover]);

  // Dropping a link just off the pet must not navigate the overlay.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  useEffect(() => () => unwatchRef.current?.(), []);

  const say = (text: string) => setBubble({ text, key: `${Date.now()}` });

  /** One-shot physical reaction to a verdict. */
  const react = (verdict: Verdict | "failed") => {
    const s = stateRef.current;
    const ladybug = ladybugRef.current;
    if (!s || !ladybug) return;
    const grounded = s.mode === "idle" || s.mode === "walking";
    switch (verdict) {
      case "benign":
        ladybug.celebrate(s.heading);
        if (grounded) {
          s.vx = 0;
          s.vy = HOP_VELOCITY;
          s.mode = "airborne";
        }
        break;
      case "suspicious":
        if (grounded) {
          s.mode = "idle";
          s.idleUntil = performance.now() + 1500;
        }
        break;
      case "malicious":
        ladybug.alarm();
        if (grounded) {
          // A small hop backwards, under the speed that would turn it around.
          s.vx = -s.heading * 50;
          s.vy = ALARM_JUMP_VELOCITY;
          s.mode = "airborne";
        }
        if (s.mode !== "dragging") s.backing = true;
        break;
      case "failed":
        break;
    }
  };

  /** Starts a scan, replacing any running one. */
  const startScan = (url: string) => {
    const gen = ++scanGenRef.current;
    unwatchRef.current?.();
    unwatchRef.current = null;
    setBubble(null);
    setScan({ phase: "scanning", id: null, url, status: "queued" });
    const current = () => gen === scanGenRef.current;

    const finish = (id: string, verdict: Verdict | "failed", score: number | null) => {
      if (!current()) return;
      setScan({ phase: "done", id, verdict, score });
      react(verdict);
    };

    createScan(url)
      .then((id) => {
        if (!current()) return;
        setScan({ phase: "scanning", id, url, status: "queued" });
        let report: { verdict: Verdict; score: number } | null = null;
        let offline = false;
        unwatchRef.current = watchScan(
          id,
          (event) => {
            if (!current()) return;
            offline = false;
            const remark = eventRemark(event);
            if (remark) say(remark);
            if (event.type === "report") {
              report = { verdict: event.verdict, score: event.score };
            } else if (event.type === "status") {
              if (event.status === "failed") {
                finish(id, "failed", null);
              } else if (event.status === "done") {
                if (report) {
                  finish(id, report.verdict, report.score);
                } else {
                  // No report event (e.g. the stream expired); read the stored one.
                  getScan(id)
                    .then((res) =>
                      res.report
                        ? finish(id, res.report.verdict, res.report.score)
                        : finish(id, "failed", null),
                    )
                    .catch(() => finish(id, "failed", null));
                }
              } else {
                const status = event.status;
                setScan((prev) =>
                  prev.phase === "scanning" && prev.id === id ? { ...prev, status } : prev,
                );
              }
            }
          },
          () => {
            // EventSource retries on its own; just mention it once per outage.
            if (!current() || offline) return;
            offline = true;
            say(OFFLINE_MESSAGE);
          },
        );
      })
      .catch((err: unknown) => {
        if (!current()) return;
        const message =
          err instanceof OfflineError
            ? OFFLINE_MESSAGE
            : err instanceof Error
              ? err.message
              : String(err);
        setScan({ phase: "error", message });
      });
  };

  const onScanRequested = useEffectEvent((url: string | null) => {
    if (url) startScan(url);
    else say(NO_CLIPBOARD_URL_MESSAGE);
  });

  useEffect(() => window.ladybug.onScanRequested((url) => onScanRequested(url)), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const s = stateRef.current!;
    e.currentTarget.setPointerCapture(e.pointerId);
    window.ladybug.setPetHeld(true);
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
    window.ladybug.setPetHeld(false);
    const s = stateRef.current!;

    if (drag.moved) {
      // Throw: keep the release velocity, capped so it stays on screen-ish.
      s.vx = Math.max(-2500, Math.min(2500, s.vx));
      s.vy = Math.max(-2500, Math.min(2500, s.vy));
      s.mode = "airborne";
      setDragging(false);
    } else if (scan.phase === "scanning" || scan.phase === "done") {
      // Click during or after a scan: open the full report.
      if (scan.id) window.ladybug.openExternal(reportUrl(scan.id));
      if (scan.phase === "done") setScan({ phase: "idle" });
    } else {
      // Click: hop and say hi.
      if (s.mode !== "airborne") {
        s.vx = 0;
        s.vy = HOP_VELOCITY;
        s.mode = "airborne";
      }
      if (scan.phase === "error") setScan({ phase: "idle" });
      fetchGreeting()
        .then(say)
        .catch(() => say(OFFLINE_MESSAGE));
    }
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    window.ladybug.showMenu();
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!carriesLink(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer.effectAllowed);
    lastDragOverRef.current = performance.now();
    setDropHover(true);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDropHover(false);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropHover(false);
    const url = linkFromDrop(e.dataTransfer);
    if (url) startScan(url);
    else say(NOT_A_LINK_MESSAGE);
  };

  const shown: Bubble | null = dropHover
    ? { text: DROP_MESSAGE, key: "drop" }
    : (bubble ?? scanBubble(scan));

  return (
    <div
      ref={petRef}
      className={dragging ? "pet dragging" : "pet"}
      style={{ width: PET_WIDTH, height: PET_HEIGHT }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {shown && (
        <div key={shown.key} className={shown.tone ? `pet-bubble ${shown.tone}` : "pet-bubble"}>
          {shown.text}
        </div>
      )}
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
