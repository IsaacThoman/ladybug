import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type { AlertLevel, PetAlert, PetFocus, PetWarning, ScanStatus, ScanVerdict, WarningChoice } from "@ladybug/shared";
import { chooseForWarning, createScan, getScan, reportUrl, subscribeToPetStream, watchScan } from "../api";
import type { OverlayLayout } from "../ladybug-api";
import { getSession } from "../session";
import { findHttpUrl, parseHttpUrl } from "../urls";
import { LadybugRenderer } from "@ladybug/mascot";
import type { LadybugMood } from "@ladybug/mascot";
import type { BrainAct } from "../brain/behavior";
import { useFlyBrain } from "../brain/useFlyBrain";
import { BERRY_PX, BERRY_RADIUS, EAT_SECONDS, EAT_SLOP, FOOD_SINK, FOOD_SIZE, OWN_APPETITE, dropFood, eatingSpot, stepFood, stepToward, throwFood, touchesFood } from "../food";
import type { Food, FoodBounds } from "../food";
import Berry from "./Berry";
import { drawBerry } from "./drawBerry";
import BrainActivity from "./BrainActivity";
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
/** How far above the bottom of the work area the bug walks. */
const GROUND_LIFT = 24;
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
/** Space between a speech bubble and the bug, and the screen edges. */
const BUBBLE_GAP = 14;
const BUBBLE_MARGIN = 8;
/** Re-enable the bubble's buttons if the browser hasn't acted on a choice by then. */
const CHOICE_TIMEOUT_MS = 6000;
/**
 * After waking, or once nothing needs it any more, the bug stays up this
 * long before heading to bed.
 */
const STAY_AWAKE_MS = 60_000;
/** Its bed: this far in from the right edge of the work area. */
const BED_INSET = 36;
const DROWSY_SPEED = WALK_SPEED * 0.5;
/** Sitting up a moment after waking, before wandering off. */
const WAKE_PAUSE_MS = 1500;
/** Flagged hosts remembered, so being on one keeps the bug awake. */
const FLAGGED_HOSTS_LIMIT = 100;

type Mode = "idle" | "walking" | "airborne" | "dragging";
/** Drowsy: shuffling off to bed. Asleep: in bed under its blanket. */
type Sleep = "awake" | "drowsy" | "asleep";

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

type FoodDrag = Pick<DragState, "pointerId" | "offsetX" | "offsetY" | "lastX" | "lastY" | "lastT">;

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

/** Adds to a bounded set of recently seen ids. */
function remember(set: Set<string>, id: string, limit = SEEN_SCANS_LIMIT) {
  set.add(id);
  if (set.size > limit) set.delete(set.values().next().value!);
}

/** A URL's host as the server reports it: lowercase, no brackets or trailing dot. */
function hostOf(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** How many letters float up with each snore. */
const SNORE_LETTERS = 3;

/** Floats a trail of "z"s up from a sleeping bug, from `at` in the layer's px. They grow as they rise. */
function snoreZs(layer: HTMLElement, at: { x: number; y: number }, heading: 1 | -1) {
  for (let i = 0; i < SNORE_LETTERS; i++) {
    const z = document.createElement("span");
    z.className = "pet-z";
    z.textContent = "z";
    z.style.left = `${at.x}px`;
    z.style.top = `${at.y}px`;
    // Each letter follows the last, drifting off the way the bug faces.
    z.style.setProperty("--i", String(i));
    z.style.setProperty("--drift", `${heading * (10 + i * 12)}px`);
    z.style.setProperty("--tilt", `${heading * -(8 + i * 6)}deg`);
    z.addEventListener("animationend", () => z.remove(), { once: true });
    layer.append(z);
  }
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

type Bounds = { minX: number; maxX: number; minY: number; groundY: number };

/**
 * Walks, turns and takes off as the fly brain says. Heading into an edge, it
 * stands there pressed against it rather than turning: the brain feels the bump.
 */
function followBrain(s: PhysicsState, act: BrainAct, dt: number, { minX, maxX, groundY }: Bounds, ladybug: LadybugRenderer) {
  s.y = groundY;
  s.heading = act.heading;
  if (act.jump) {
    s.vx = act.jump.vx;
    s.vy = act.jump.vy;
    s.mode = "airborne";
    ladybug.startle();
    return;
  }
  const x = Math.min(Math.max(s.x + act.vx * dt, minX), maxX);
  s.mode = x !== s.x ? "walking" : "idle";
  s.x = x;
  // If the brain drops out mid-walk, the walk ends here.
  s.targetX = x;
}

/**
 * Keeps a speech bubble next to the bug: above it (below it near the top of
 * the screen), on screen, with its tail pointing at the bug.
 */
function placeBubble(bubble: HTMLElement, s: PhysicsState, workArea: OverlayLayout["workArea"]) {
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;
  if (width === 0) {
    // Hidden: placed afresh, unseen, when it shows again.
    delete bubble.dataset.side;
    return;
  }
  const center = s.x + PET_WIDTH / 2;
  const left = Math.min(
    Math.max(center - width / 2, workArea.x + BUBBLE_MARGIN),
    workArea.x + workArea.width - width - BUBBLE_MARGIN,
  );
  const above = s.y - BUBBLE_GAP - height >= workArea.y + BUBBLE_MARGIN;
  const top = Math.max(
    workArea.y + BUBBLE_MARGIN,
    Math.min(
      above ? s.y - BUBBLE_GAP - height : s.y + PET_HEIGHT + BUBBLE_GAP,
      workArea.y + workArea.height - height - BUBBLE_MARGIN,
    ),
  );
  bubble.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  bubble.style.setProperty("--tail-x", `${Math.min(Math.max(center - left, 22), width - 22)}px`);
  const side = above ? "above" : "below";
  if (bubble.dataset.side !== side) bubble.dataset.side = side;
}

export default function Pet({ layout, callBusy, call, requestHelp, onAccountNeeded }: {
  layout: OverlayLayout;
  callBusy: boolean;
  /** The support call's bubble: its status, controls and the caller's video. Kept mounted so the video element lives on. */
  call: { open: boolean; content: ReactNode };
  requestHelp: () => void;
  onAccountNeeded: () => void;
}) {
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
  const callBubbleRef = useRef<HTMLElement>(null);
  /** Holds the bug still while its bubble is up, so the buttons don't wander off. */
  const holdRef = useRef(false);
  const seenWarningsRef = useRef(new Set<string>());
  const lastFretRef = useRef(0);
  /** Whether the page in the browser's active tab is being checked, from the server. */
  const [focus, setFocus] = useState<PetFocus | null>(null);
  const { brain, showActivity, eyes } = useFlyBrain({ walkSpeed: WALK_SPEED, hopVelocity: HOP_VELOCITY, jumpVelocity: ALARM_JUMP_VELOCITY });
  /** Hosts the server flagged as unsafe on a visit, or blocked. Being on one keeps the bug up. */
  const [flaggedHosts, setFlaggedHosts] = useState<ReadonlySet<string>>(() => new Set());
  const [sleep, setSleep] = useState<Sleep>("awake");
  const sleepRef = useRef<Sleep>("awake");
  /** performance.now() until which the bug stays up, set when the loop starts. */
  const awakeUntilRef = useRef(0);
  /** Something needs the bug awake right now. */
  const restlessRef = useRef(false);
  const snoreLayerRef = useRef<HTMLDivElement>(null);
  /** The berry on screen, if the bug has been given one. The animation loop moves and eats it. */
  const foodRef = useRef<Food | null>(null);
  const foodElRef = useRef<HTMLDivElement>(null);
  const foodDragRef = useRef<FoodDrag | null>(null);
  const [hasFood, setHasFood] = useState(false);

  const warning = warnings.at(-1) ?? null;
  // A support call has the bug's attention; blocked pages wait until it's over.
  const showBubble = warning !== null && !menu && !call.open;
  // The page the user is looking at is being checked: stand still and look it
  // over through the magnifying glass. Blocked pages, reactions and drops come first.
  const inspecting = Boolean(focus?.investigating) && !dropHover && warning === null && scan.phase !== "done";
  const inspectingRef = useRef(false);
  const mood = moodFor(scan, dropHover, warning !== null, inspecting);
  const focusHost = hostOf(focus?.url);
  // No sleeping on the job: while the user is on a flagged site, a page is
  // being checked or blocked, there's a call, or the user is handling the bug.
  const onFlaggedSite = warnings.length > 0 || (focusHost !== null && flaggedHosts.has(focusHost));
  const restless =
    onFlaggedSite ||
    scan.phase !== "idle" ||
    Boolean(focus?.investigating) ||
    call.open ||
    callBusy ||
    dropHover ||
    dragging ||
    menu !== null;

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    moodRef.current = mood;
    inspectingRef.current = inspecting;
  }, [mood, inspecting]);

  useEffect(() => {
    holdRef.current = showBubble || call.open;
  }, [showBubble, call.open]);

  useEffect(() => brain.setLinkOver(dropHover), [brain, dropHover]);
  useEffect(() => {
    restlessRef.current = restless;
  }, [restless]);

  const settle = (next: Sleep) => {
    sleepRef.current = next;
    setSleep(next);
  };

  /** Something disturbed the bug: wake it if it's dozing, and keep it up a while. */
  const wake = () => {
    const now = performance.now();
    awakeUntilRef.current = now + STAY_AWAKE_MS;
    if (sleepRef.current === "awake") return;
    const wasAsleep = sleepRef.current === "asleep";
    settle("awake");
    // Blinks and stretches before wandering off.
    const s = stateRef.current;
    if (wasAsleep && s?.mode === "idle") s.idleUntil = Math.max(s.idleUntil, now + WAKE_PAUSE_MS);
  };

  // For the animation loop, which is set up once.
  const wakeFromLoop = useEffectEvent(() => wake());
  const settleFromLoop = useEffectEvent((next: Sleep) => settle(next));
  const foodGoneFromLoop = useEffectEvent(() => setHasFood(false));

  const flagHosts = (hosts: string[]) => {
    if (hosts.length === 0) return;
    setFlaggedHosts((prev) => {
      if (hosts.every((host) => prev.has(host))) return prev;
      const next = new Set(prev);
      for (const host of hosts) remember(next, host, FLAGGED_HOSTS_LIMIT);
      return next;
    });
  };

  // Movement bounds are the display work area or the development window.
  const getBounds = (): Bounds => {
    const { workArea } = layoutRef.current;
    return {
      minX: workArea.x,
      maxX: workArea.x + workArea.width - PET_WIDTH,
      minY: workArea.y,
      groundY: workArea.y + workArea.height - PET_HEIGHT - GROUND_LIFT,
    };
  };

  // Where the berry's grab box can be. It rests just in front of the bug's ground line.
  const getFoodBounds = (): FoodBounds => {
    const { workArea } = layoutRef.current;
    return {
      minX: workArea.x,
      maxX: workArea.x + workArea.width - FOOD_SIZE,
      minY: workArea.y,
      groundY: workArea.y + workArea.height - GROUND_LIFT + FOOD_SINK - FOOD_SIZE,
    };
  };

  /** A berry pops out next to the bug, replacing any it already has. */
  const feed = () => {
    const s = stateRef.current;
    if (!s) return;
    wake();
    foodRef.current = dropFood({ centreX: s.x + PET_WIDTH / 2, y: s.y, heading: s.heading }, getFoodBounds());
    setHasFood(true);
  };

  const onFeedRequested = useEffectEvent(() => feed());
  useEffect(() => window.ladybug.onFeedRequested(() => onFeedRequested()), []);

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

    awakeUntilRef.current = performance.now() + STAY_AWAKE_MS;

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

      // Bedtime, once nothing has needed the bug for a while. Anything that
      // needs it wakes it straight back up.
      if (restlessRef.current) {
        wakeFromLoop();
      } else if (
        sleepRef.current === "awake" &&
        now >= awakeUntilRef.current &&
        (s.mode === "idle" || s.mode === "walking") &&
        !menuOpenRef.current
      ) {
        settleFromLoop("drowsy");
        s.mode = "idle";
        s.backing = false;
        s.idleUntil = now;
      }
      const sleep = sleepRef.current;
      const bedX = Math.max(minX, maxX - BED_INSET);

      // Nervous bugs potter about nearby instead of crossing the screen.
      const pottering = mood === "nervous";
      const speed =
        sleep === "drowsy" ? DROWSY_SPEED
        : s.backing ? WALK_SPEED * 0.6
        : pottering ? WALK_SPEED * 0.35
        : WALK_SPEED;

      // Searching with the magnifying glass, it stands still and faces forward.
      const holding = mood === "expectant" || mood === "sniffing" || holdRef.current || inspectingRef.current;
      // With the fly brain on, it decides where to go instead of wandering at
      // random, but only when nothing else is keeping the bug busy. Bedtime
      // is the pet's own: the brain doesn't walk it to bed, and rests while it sleeps.
      const free = sleep === "awake" && (s.mode === "idle" || s.mode === "walking") && !menuOpenRef.current && !holding && !pottering && !s.backing && now >= s.idleUntil;
      // The berry: it falls where it's dropped, and the bug eats it standing
      // beside it. With the fly brain, that's when the brain tastes it and
      // wants to feed; without, the bug walks over to it by itself.
      const food = foodRef.current;
      const foodBounds = getFoodBounds();
      if (food) stepFood(food, dt, foodBounds);
      const centreX = s.x + PET_WIDTH / 2;
      const spot = food ? eatingSpot({ centreX, heading: s.heading }, food.x + FOOD_SIZE / 2, minX + PET_WIDTH / 2, maxX + PET_WIDTH / 2) : null;
      const onFeet = s.mode === "idle" || s.mode === "walking";
      const { width, height } = layoutRef.current;
      const act = brain.frame({
        now,
        dt,
        pet: { x: s.x, y: s.y, width: PET_WIDTH, height: PET_HEIGHT, mode: s.mode, heading: s.heading },
        bounds: { minX, maxX },
        held: dragRef.current !== null,
        free,
        asleep: sleep === "asleep",
        food: food && onFeet && touchesFood(centreX, food, foodBounds) ? spot : null,
        // For the eyes: the bug stands on a ledge along its ground line, just in front of the screen.
        scene: {
          width,
          height,
          ledgeY: groundY + PET_HEIGHT,
          yaw: ladybug.facing,
          sprite: { x: s.x + (PET_WIDTH - CANVAS_WIDTH) / 2, y: s.y + PET_HEIGHT + GROUND_PX - CANVAS_HEIGHT, width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
          berry: food && { x: food.x, y: food.y, width: FOOD_SIZE, height: FOOD_SIZE },
          ball: food && { x: food.x + FOOD_SIZE / 2, y: food.y + FOOD_SIZE - BERRY_PX / 2, radius: BERRY_RADIUS },
        },
      });
      const own: BrainAct | null = !act && free && spot && food?.mode === "resting"
        ? { vx: stepToward(spot.dx, speed, dt), heading: spot.heading, jump: null, wings: 0, groom: 0, eat: Math.abs(spot.dx) <= EAT_SLOP ? OWN_APPETITE : 0 }
        : null;
      const lead = act ?? own;
      let eating = 0;
      if (lead && free) {
        // A fright keeps it up.
        if (lead.jump) wakeFromLoop();
        followBrain(s, lead, dt, { minX, maxX, minY, groundY }, ladybug);
        if (food && s.mode === "idle") eating = lead.eat;
      }
      else if (!menuOpenRef.current) switch (s.mode) {
        case "idle":
          s.y = groundY;
          // Hold still while a link is dragged over it, while it's warning
          // about a page, or while it searches with the magnifying glass.
          if (holding || sleep === "asleep") s.idleUntil = Math.max(s.idleUntil, now + 300);
          if (now >= s.idleUntil) {
            if (sleep === "drowsy") {
              s.targetX = bedX;
              s.heading = bedX >= s.x ? 1 : -1;
            } else if (s.backing) {
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
          if (sleep === "drowsy") s.targetX = bedX;
          const dx = s.targetX - s.x;
          s.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
          if (Math.abs(dx) < 1) {
            s.mode = "idle";
            s.backing = false;
            s.idleUntil = now + (pottering ? randomBetween(500, 1600) : randomBetween(1500, 6000));
            if (sleep === "drowsy") {
              // Tucked up in bed, facing out across the screen.
              s.heading = -1;
              settleFromLoop("asleep");
            }
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

      if (food) {
        if (eating > 0) {
          food.left -= (eating * dt) / EAT_SECONDS;
          // The bites come out of the side the bug is on.
          food.biteFrom = s.heading === 1 ? -1 : 1;
          // No dozing off over dinner.
          wakeFromLoop();
        }
        if (food.left <= 0) {
          foodRef.current = null;
          foodGoneFromLoop();
        } else if (foodElRef.current) {
          drawBerry(foodElRef.current, food);
        }
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
      // Speech bubbles ride along with the bug.
      if (bubbleRef.current) placeBubble(bubbleRef.current, s, layoutRef.current.workArea);
      if (callBubbleRef.current) placeBubble(callBubbleRef.current, s, layoutRef.current.workArea);
      // On-screen velocity, so drags (which move x outside this loop) count too.
      const vx = dt > 0 ? (s.x - prevX) / dt : 0;
      prevX = s.x;
      if (s.mode === "dragging" && Math.abs(vx) > 120) s.heading = vx > 0 ? 1 : -1;
      // Grooming on the spot, whenever it's up, standing and has nothing in hand.
      const groom = act && sleep === "awake" && s.mode === "idle" && !holding && eating === 0 ? act.groom : undefined;
      ladybug.render(
        { mode: s.mode, vx, heading: s.heading, mood, inspect: inspectingRef.current, sleep: sleep === "awake" ? undefined : sleep, wings: act?.wings, groom, eat: eating },
        dt,
      );
      const snore = ladybug.takeSnore();
      if (snore && snoreLayerRef.current) snoreZs(snoreLayerRef.current, snore, s.heading);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      ladybugRef.current = null;
      ladybug.dispose();
    };
  }, [brain]);

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
    wake();
    if (level === "danger") flagHosts([alert.host]);

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
    wake();
    flagHosts(fresh.map((w) => w.host.toLowerCase()));
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
    wake();
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

  // The berry is grabbed, carried and thrown like the bug.
  const onFoodPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const food = foodRef.current;
    if (e.button !== 0 || !food) return;
    wake();
    e.currentTarget.setPointerCapture(e.pointerId);
    window.ladybug.setPetHeld(true);
    food.mode = "dragging";
    food.vx = 0;
    food.vy = 0;
    foodDragRef.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - food.x,
      offsetY: e.clientY - food.y,
      lastX: e.clientX,
      lastY: e.clientY,
      lastT: performance.now(),
    };
  };

  const onFoodPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = foodDragRef.current;
    const food = foodRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !food) return;
    const now = performance.now();
    const dt = Math.max((now - drag.lastT) / 1000, 1 / 240);
    food.vx = (e.clientX - drag.lastX) / dt;
    food.vy = (e.clientY - drag.lastY) / dt;
    food.x = e.clientX - drag.offsetX;
    food.y = e.clientY - drag.offsetY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.lastT = now;
  };

  const onFoodPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = foodDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    foodDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    window.ladybug.setPetHeld(false);
    if (foodRef.current) throwFood(foodRef.current);
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
    wake();
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
    if (!url) return;
    brain.feed();
    startScan(url);
  };

  const busy = answer !== null && answer.id === warning?.id && answer.state !== "failed";
  const others = warnings.length - 1;

  return (
    <>
    {showBubble && <section
      ref={bubbleRef}
      key={warning.id}
      className="pet-bubble pet-warning"
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
      <div className="pet-bubble-actions">
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
    <section
      ref={callBubbleRef}
      className="pet-bubble pet-call"
      aria-label="Support call"
      data-overlay-interactive
      hidden={!call.open}
      style={{ maxWidth: layout.workArea.width - BUBBLE_MARGIN * 2 }}
    >
      {call.content}
    </section>
    {showActivity && <BrainActivity brain={brain} layout={layout} eyes={eyes} />}
    {menu && <div ref={menuRef} className="pet-menu" role="menu" aria-label="Computerbug" data-overlay-interactive
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
      <button role="menuitem" onClick={() => { closeMenu(); feed(); }}>Feed</button>
      {reportId && <button role="menuitem" onClick={() => { closeMenu(); window.ladybug.openExternal(reportUrl(reportId)); }}>View report</button>}
    </div>}
    {hasFood && <Berry
      ref={foodElRef}
      onPointerDown={onFoodPointerDown}
      onPointerMove={onFoodPointerMove}
      onPointerUp={onFoodPointerUp}
      onPointerCancel={onFoodPointerUp}
    />}
    <div
      ref={petRef}
      role="button"
      tabIndex={0}
      aria-label={sleep === "asleep" ? "Computerbug menu (asleep)" : "Computerbug menu"}
      aria-haspopup="menu"
      aria-expanded={Boolean(menu)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMenu(); }
        if (e.key === "Escape") closeMenu();
      }}
      className={dragging ? "pet dragging" : "pet"}
      data-sleep={sleep}
      style={{ width: PET_WIDTH, height: PET_HEIGHT }}
      data-overlay-interactive
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onPointerEnter={() => brain.setHovered(true)}
      onPointerLeave={() => brain.setHovered(false)}
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
      {/* Snores: each "z" floats up from the canvas point the renderer gives. */}
      <div
        ref={snoreLayerRef}
        className="pet-snore"
        aria-hidden
        style={{ left: (PET_WIDTH - CANVAS_WIDTH) / 2, top: PET_HEIGHT + GROUND_PX - CANVAS_HEIGHT }}
      />
    </div>
    </>
  );
}
