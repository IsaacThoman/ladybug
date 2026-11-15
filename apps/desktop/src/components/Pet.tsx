import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { AlertLevel, PetAlert, PetFocus, PetWarning, ScanStatus, ScanVerdict, WarningChoice } from "@ladybug/shared";
import { chooseForWarning, createScan, getScan, reportUrl, subscribeToPetStream, watchScan } from "../api";
import type { OverlayLayout } from "../ladybug-api";
import { getSession } from "../session";
import { findHttpUrl, parseHttpUrl } from "../urls";
import { LadybugRenderer } from "@ladybug/mascot";
import type { LadybugMood } from "@ladybug/mascot";
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
const REACTION_MS = 30_000;
/** How long reactions to server alerts last. */
const ALERT_REACTION_MS = { benign: 4000, malicious: 12000 };
// Chromium repeats dragover while a drag hovers, even if the cursor is still.
// If they stop without a dragleave (the overlay went click-through mid-drag),
// the drag has left.
const DRAG_HOVER_STALE_MS = 400;
/** How many scan ids to remember for de-duplicating reactions. */
const SEEN_SCANS_LIMIT = 100;
/** Space between the warning bubble and the bug, and the screen edges. */
const BUBBLE_GAP = 14;
const BUBBLE_MARGIN = 8;
/** Re-enable the bubble's buttons if the browser hasn't acted on a choice by then. */
const CHOICE_TIMEOUT_MS = 6000;

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

/** "manual": the user dropped a link or scanned the clipboard. "alert": the server started it. */
type ScanOrigin = "manual" | "alert";

type ScanState =
  | { phase: "idle" }
  /** `id` is null until the server accepts the scan. */
  | { phase: "scanning"; origin: ScanOrigin; id: string | null; url: string; status: ScanStatus }
  /** A verdict reaction. `fromAlert` reactions came from a server alert and are shorter. */
  | {
      phase: "done";
      id: string | null;
      verdict: ScanVerdict | "failed";
      score: number | null;
      fromAlert: boolean;
    };

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

/** Adds to a bounded set of recently seen scan ids. */
function remember(set: Set<string>, id: string) {
  set.add(id);
  if (set.size > SEEN_SCANS_LIMIT) set.delete(set.values().next().value!);
}

function moodFor(scan: ScanState, dropHover: boolean, blocking: boolean, inspecting: boolean): LadybugMood {
  if (dropHover) return "expectant";
  // Scared for as long as the browser is blocking an unsafe page.
  if (blocking) return "alarmed";
  if (scan.phase === "done") {
    if (scan.verdict === "benign") return "happy";
    if (scan.verdict === "suspicious") return "nervous";
    if (scan.verdict === "malicious") return "alarmed";
  }
  if (scan.phase === "scanning" || inspecting) return "sniffing";
  return "calm";
}

/**
 * Whether a server alert may replace the current scan state. A scan the user
 * started is never interrupted, and a fresh danger reaction only gives way to
 * another danger.
 */
function alertCanTakeOver(scan: ScanState, level: AlertLevel) {
  if (scan.phase === "scanning" && scan.origin === "manual") return false;
  if (scan.phase === "done" && scan.verdict === "malicious") return level === "danger";
  return true;
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

export default function Pet({ layout, callBusy, requestHelp, onAccountNeeded }: { layout: OverlayLayout; callBusy: boolean; requestHelp: () => void; onAccountNeeded: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOpenRef = useRef(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const closeMenu = () => { menuOpenRef.current = false; setMenu(null); petRef.current?.focus(); };
  const toggleMenu = () => {
    if (menuOpenRef.current) { closeMenu(); return; }
    const rect = petRef.current?.getBoundingClientRect();
    if (!rect) return;
    menuOpenRef.current = true;
    setMenu({ x: rect.x + PET_WIDTH / 2, y: rect.y - 8 });
  };
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
  /** Scans the pet has followed, so a repeat alert doesn't follow them again. */
  const followedScansRef = useRef(new Set<string>());
  /**
   * Scans the pet has already reacted to. A scan's result can arrive both on
   * its own event stream and as a server alert; only the first one reacts.
   */
  const reactedScansRef = useRef(new Set<string>());
  const lastDragOverRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [scan, setScan] = useState<ScanState>({ phase: "idle" });
  /** Unsafe pages the browser is blocking, oldest first. The bubble speaks for the newest. */
  const [warnings, setWarnings] = useState<PetWarning[]>([]);
  /** The warning a choice was just sent for, or that couldn't be sent. */
  const [answer, setAnswer] = useState<{ id: string; state: "sending" | "sent" | "failed" } | null>(null);
  const bubbleRef = useRef<HTMLElement>(null);
  /** Holds the bug still while its bubble is up, so the buttons don't wander off. */
  const holdRef = useRef(false);
  const seenWarningsRef = useRef(new Set<string>());
  const lastFretRef = useRef(0);
  /** Whether the page in the browser's active tab is being checked, from the server. */
  const [focus, setFocus] = useState<PetFocus | null>(null);

  const warning = warnings.at(-1) ?? null;
  const showBubble = warning !== null && !menu;
  // The page the user is looking at is being checked: stand still and look it
  // over through the magnifying glass. Blocked pages, reactions and drops come first.
  const inspecting = Boolean(focus?.investigating) && !dropHover && warning === null && scan.phase !== "done";
  const inspectingRef = useRef(false);
  const mood = moodFor(scan, dropHover, warning !== null, inspecting);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    moodRef.current = mood;
    inspectingRef.current = inspecting;
  }, [mood, inspecting]);

  useEffect(() => {
    holdRef.current = showBubble;
  }, [showBubble]);

  // Movement bounds are the display work area or the development window.
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
      s.targetX = Math.min(Math.max(s.targetX, minX), maxX);
      // Sniffing and nervous bugs potter about nearby instead of crossing the screen.
      const pottering = mood === "sniffing" || mood === "nervous";
      const speed = s.backing
        ? WALK_SPEED * 0.6
        : mood === "sniffing"
          ? WALK_SPEED * 0.45
          : mood === "nervous"
            ? WALK_SPEED * 0.35
            : WALK_SPEED;

      const holding = mood === "expectant" || holdRef.current || inspectingRef.current;
      if (!menuOpenRef.current) switch (s.mode) {
        case "idle":
          s.y = groundY;
          // Hold still while a link is dragged over it, while it's warning
          // about a page, or while it inspects the active tab.
          if (holding) s.idleUntil = Math.max(s.idleUntil, now + 300);
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
          if (holding) {
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

      // Keep the pet visible when its window or display shrinks.
      s.x = Math.min(Math.max(s.x, minX), maxX);
      s.y = Math.min(Math.max(s.y, minY), groundY);

      if (petRef.current) {
        petRef.current.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`;
      }
      // The main process hit-tests the cursor against this to toggle click-through.
      if (Math.abs(s.x - reportedX) >= 0.5 || Math.abs(s.y - reportedY) >= 0.5) {
        reportedX = s.x;
        reportedY = s.y;
        window.ladybug.setPetRect({ x: s.x, y: s.y, width: PET_WIDTH, height: PET_HEIGHT });
      }
      // The warning bubble rides above the bug (below it near the top of the
      // screen), kept on screen, with its tail pointing at the bug.
      const bubble = bubbleRef.current;
      if (bubble) {
        const { workArea } = layoutRef.current;
        const width = bubble.offsetWidth;
        const height = bubble.offsetHeight;
        const center = s.x + PET_WIDTH / 2;
        const left = Math.min(
          Math.max(center - width / 2, workArea.x + BUBBLE_MARGIN),
          workArea.x + workArea.width - width - BUBBLE_MARGIN,
        );
        const above = s.y - BUBBLE_GAP - height >= workArea.y + BUBBLE_MARGIN;
        const top = above ? s.y - BUBBLE_GAP - height : s.y + PET_HEIGHT + BUBBLE_GAP;
        bubble.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
        bubble.style.setProperty("--tail-x", `${Math.min(Math.max(center - left, 22), width - 22)}px`);
        const side = above ? "above" : "below";
        if (bubble.dataset.side !== side) bubble.dataset.side = side;
      }
      // On-screen velocity, so drags (which move x outside this loop) count too.
      const vx = dt > 0 ? (s.x - prevX) / dt : 0;
      prevX = s.x;
      if (s.mode === "dragging" && Math.abs(vx) > 120) s.heading = vx > 0 ? 1 : -1;
      ladybug.render({ mode: s.mode, vx, heading: s.heading, mood, inspect: inspectingRef.current }, dt);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      ladybugRef.current = null;
      ladybug.dispose();
    };
  }, []);

  // Hold a verdict reaction for a while, then calm down.
  useEffect(() => {
    if (scan.phase !== "done") return;
    const ms = scan.fromAlert
      ? ALERT_REACTION_MS[scan.verdict === "benign" ? "benign" : "malicious"]
      : REACTION_MS;
    const timeout = setTimeout(() => setScan({ phase: "idle" }), ms);
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

  /** One-shot physical reaction to a verdict. */
  const react = (verdict: ScanVerdict | "failed") => {
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

  /** Stops following the current scan. Returns the generation for the next one. */
  const stopScan = () => {
    unwatchRef.current?.();
    unwatchRef.current = null;
    return ++scanGenRef.current;
  };

  /** Follows a scan's events until its verdict, then reacts. */
  const watch = (gen: number, id: string) => {
    const current = () => gen === scanGenRef.current;
    remember(followedScansRef.current, id);

    const finish = (verdict: ScanVerdict | "failed", score: number | null) => {
      if (!current()) return;
      if (reactedScansRef.current.has(id)) {
        // Its alert got here first and already reacted; just fill in the details.
        if (verdict !== "failed") {
          setScan((prev) =>
            prev.phase === "done" && prev.id === id ? { ...prev, verdict, score } : prev,
          );
        }
        return;
      }
      remember(reactedScansRef.current, id);
      if (verdict !== "failed") setReportId(id);
      setScan({ phase: "done", id, verdict, score, fromAlert: false });
      react(verdict);
    };

    let report: { verdict: ScanVerdict; score: number } | null = null;
    unwatchRef.current = watchScan(id, (event) => {
      if (!current()) return;
      if (event.type === "report") {
        report = { verdict: event.verdict, score: event.score };
      } else if (event.type === "status") {
        if (event.status === "failed") {
          finish("failed", null);
        } else if (event.status === "done") {
          if (report) {
            finish(report.verdict, report.score);
          } else {
            // No report event (e.g. the stream expired); read the stored one.
            getScan(id)
              .then((res) =>
                res.report
                  ? finish(res.report.verdict, res.report.score)
                  : finish("failed", null),
              )
              .catch(() => finish("failed", null));
          }
        } else {
          const status = event.status;
          setScan((prev) =>
            prev.phase === "scanning" && prev.id === id ? { ...prev, status } : prev,
          );
        }
      }
    });
  };

  /** Starts a scan the user asked for, replacing any running one. */
  const startScan = (url: string) => {
    const session = getSession();
    if (session?.account.status !== "approved") {
      onAccountNeeded();
      return;
    }
    const gen = stopScan();
    setScan({ phase: "scanning", origin: "manual", id: null, url, status: "queued" });

    createScan(url)
      .then((id) => {
        if (gen !== scanGenRef.current) return;
        setScan({ phase: "scanning", origin: "manual", id, url, status: "queued" });
        watch(gen, id);
      })
      .catch(() => {
        if (gen !== scanGenRef.current) return;
        setScan({ phase: "idle" });
      });
  };

  const onScanRequested = useEffectEvent((url: string | null) => {
    if (url) startScan(url);
  });

  useEffect(() => window.ladybug.onScanRequested((url) => onScanRequested(url)), []);

  // Alerts from the server about sites visited in the browser. Unknown sites
  // get a sandbox scan, which the pet follows as if the user had dropped the link.
  const onAlert = useEffectEvent((alert: PetAlert) => {
    const { level, scanId } = alert;
    const ladybug = ladybugRef.current;

    if (level === "info") {
      // "Checking it…" (or "couldn't finish"): follow the scan if it's new to us.
      ladybug?.startle(1);
      const known =
        scanId !== undefined &&
        (followedScansRef.current.has(scanId) || reactedScansRef.current.has(scanId));
      if (scanId && !known && alertCanTakeOver(scan, level)) {
        const gen = stopScan();
        setScan({ phase: "scanning", origin: "alert", id: scanId, url: alert.url, status: "queued" });
        watch(gen, scanId);
      }
      return;
    }

    // danger / ok. The scan's own stream may have reported this result already.
    if (scanId) {
      if (reactedScansRef.current.has(scanId)) return;
      remember(reactedScansRef.current, scanId);
    }
    if (scanId) setReportId(scanId);
    if (level === "danger") ladybug?.startle(3);
    if (!alertCanTakeOver(scan, level)) {
      // Busy with the user's own scan: flash a warning without dropping it.
      if (level === "danger") ladybug?.alarm();
      return;
    }
    // Keep watching if this is the scan being followed; its stream fills in the score.
    const following = scan.phase === "scanning" && scanId !== undefined && scan.id === scanId;
    if (!following) stopScan();
    const verdict: ScanVerdict = level === "danger" ? "malicious" : "benign";
    setScan({ phase: "done", id: scanId ?? null, verdict, score: null, fromAlert: true });
    react(verdict);
  });

  // Pages the browser is blocking. Each new one gets a fright; the bug stays
  // scared until they're all gone.
  const onWarnings = useEffectEvent((next: PetWarning[]) => {
    setWarnings(next);
    setAnswer((prev) => (prev && next.some((w) => w.id === prev.id) ? prev : null));
    const fresh = next.filter((w) => !seenWarningsRef.current.has(w.id));
    if (fresh.length === 0) return;
    for (const w of fresh) remember(seenWarningsRef.current, w.id);
    const ladybug = ladybugRef.current;
    ladybug?.startle(3);
    // The visit's danger alert usually got here first and already jumped.
    if (scan.phase === "done" && scan.verdict === "malicious") ladybug?.alarm();
    else react("malicious");
  });

  useEffect(() => subscribeToPetStream({ onAlert: (alert) => onAlert(alert), onWarnings: (next) => onWarnings(next), onFocus: setFocus }), []);

  // A choice the browser hasn't acted on in a while can be tried again.
  useEffect(() => {
    if (answer?.state !== "sent") return;
    const timeout = setTimeout(() => setAnswer(null), CHOICE_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [answer]);

  const choose = (id: string, choice: WarningChoice) => {
    setAnswer({ id, state: "sending" });
    chooseForWarning(id, choice)
      .then((open) => {
        if (open) setAnswer((prev) => (prev?.id === id ? { id, state: "sent" } : prev));
        else {
          // Already gone from the browser (closed, or answered there).
          setWarnings((prev) => prev.filter((w) => w.id !== id));
          setAnswer(null);
        }
      })
      .catch(() => setAnswer((prev) => (prev?.id === id ? { id, state: "failed" } : prev)));
  };

  /** Wings flare when the pointer heads for "Continue anyway". */
  const fret = () => {
    const ladybug = ladybugRef.current;
    if (!ladybug || performance.now() - lastFretRef.current < 2000) return;
    lastFretRef.current = performance.now();
    ladybug.startle();
    ladybug.alarm();
  };

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
      closeMenu();
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
    } else if (e.type !== "pointercancel") {
      toggleMenu();
    }
  };

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const area = layout.workArea;
    el.style.left = `${Math.max(area.x, Math.min(menu.x - el.offsetWidth / 2, area.x + area.width - el.offsetWidth))}px`;
    el.style.top = `${Math.max(area.y, Math.min(menu.y - el.offsetHeight, area.y + area.height - el.offsetHeight))}px`;
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu, layout, reportId]);

  useEffect(() => {
    if (!menu) return;
    window.ladybug.setMenuOpen(true);
    const dismiss = () => { menuOpenRef.current = false; setMenu(null); };
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !petRef.current?.contains(event.target)) dismiss();
    };
    const unsubscribe = window.ladybug.onMenuDismiss(dismiss);
    document.addEventListener("pointerdown", pointer, true);
    return () => { window.ladybug.setMenuOpen(false); unsubscribe(); document.removeEventListener("pointerdown", pointer, true); };
  }, [menu]);

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    closeMenu();
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
  };

  const busy = answer !== null && answer.id === warning?.id && answer.state !== "failed";
  const others = warnings.length - 1;

  return (
    <>
    {showBubble && <section
      ref={bubbleRef}
      key={warning.id}
      className="pet-warning"
      role="alertdialog"
      aria-labelledby="pet-warning-title"
      aria-describedby="pet-warning-summary"
      data-overlay-interactive
      style={{ maxWidth: layout.workArea.width - BUBBLE_MARGIN * 2 }}
    >
      <p className="pet-warning-chip">Unsafe page blocked</p>
      <h2 id="pet-warning-title">{warning.late ? "This page turned out to be dangerous" : "That page looks dangerous!"}</h2>
      <p id="pet-warning-summary" className="pet-warning-summary">
        {warning.late ? (
          <>I just finished checking <strong>{warning.host}</strong>, and it isn't safe, so I blocked it. Don't enter passwords or payment details, or download anything from it.</>
        ) : (
          <>I blocked <strong>{warning.host}</strong> in your browser. It could try to steal your passwords or payment details, or install something harmful.</>
        )}
      </p>
      <div className="pet-warning-details">
        {warning.reason && <p className="pet-warning-reason">{warning.reason}</p>}
        <p className="pet-warning-url" title={warning.url}>{warning.url}</p>
      </div>
      <div className="pet-warning-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => choose(warning.id, "exit")}>Get me out of here</button>
        <button type="button" className="ghost" disabled={busy} onPointerEnter={fret} onFocus={fret} onClick={() => choose(warning.id, "continue")}>Continue anyway</button>
      </div>
      {answer?.id === warning.id && answer.state === "failed" ? (
        <p className="pet-warning-note" role="alert">I couldn't reach your browser. Try again, or use the page itself.</p>
      ) : (
        <p className="pet-warning-note">
          {others > 0 ? `${others} more blocked ${others === 1 ? "page" : "pages"} after this one. ` : ""}
          Continuing hides the warning for the rest of the browser session.
        </p>
      )}
    </section>}
    {menu && <div ref={menuRef} className="pet-menu" role="menu" aria-label="Ladybugg" data-overlay-interactive
      style={{ maxWidth: layout.workArea.width, maxHeight: layout.workArea.height }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(e.key)) {
          e.preventDefault();
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const index = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (current + (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1) + buttons.length) % buttons.length;
          buttons[index]?.focus();
        }
      }}>
      <button role="menuitem" disabled={callBusy} onClick={() => { closeMenu(); requestHelp(); }}>Request help</button>
      <button role="menuitem" onClick={() => { closeMenu(); window.ladybug.scanClipboard(); }}>Scan clipboard URL</button>
      {reportId && <button role="menuitem" onClick={() => { closeMenu(); window.ladybug.openExternal(reportUrl(reportId)); }}>View report</button>}
    </div>}
    <div
      ref={petRef}
      role="button"
      tabIndex={0}
      aria-label="Ladybugg menu"
      aria-haspopup="menu"
      aria-expanded={Boolean(menu)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMenu(); }
        if (e.key === "Escape") closeMenu();
      }}
      className={dragging ? "pet dragging" : "pet"}
      style={{ width: PET_WIDTH, height: PET_HEIGHT }}
      data-overlay-interactive
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
    </>
  );
}
