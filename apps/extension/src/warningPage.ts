import { LadybugRenderer } from "@ladybug/mascot";
import type { WarningDetails, WarningMessage } from "./warning";
import "@ladybug/mascot/garden.css";
import "./warning.css";

// The warning shown over an unsafe page, framed by the overlay (overlay.ts).
// Its URL only carries a token; the details come from the background worker.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const token = location.hash.slice(1);
/** Shown as the whole tab, rather than framed over the page (see the "page" warning mode). */
const asPage = new URLSearchParams(location.search).has("page");
const card = document.querySelector<HTMLElement>(".card")!;
const exitEl = $<HTMLButtonElement>("exit");
const continueEl = $<HTMLButtonElement>("continue");

const send = (type: WarningMessage["type"]) =>
  chrome.runtime.sendMessage<WarningMessage, WarningDetails>({ type, token });

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The 3D ladybug, alarmed. Falls back to the still mark without WebGL. */
function startLadybug() {
  const canvas = $<HTMLCanvasElement>("ladybug");
  const unit = 104;
  const width = Math.round(unit * 1.8);
  const height = Math.round(unit * 1.5);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  let renderer: LadybugRenderer;
  try {
    renderer = new LadybugRenderer(canvas, { width, height, unitPx: unit, groundPx: Math.round(unit * 0.21) });
  } catch {
    canvas.hidden = true;
    $<HTMLImageElement>("ladybug-fallback").hidden = false;
    return null;
  }

  let last = performance.now();
  const tick = (now: number) => {
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    renderer.render({ mode: "idle", vx: 0, heading: 1, mood: "alarmed", look: 0 }, dt);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return renderer;
}

function show(details: NonNullable<WarningDetails>) {
  $("host").textContent = details.host;
  $("reason").textContent = details.reason;
  $("url").textContent = details.url;
  $("url").title = details.url;
  if (details.late) {
    $("title").textContent = "This page turned out to be dangerous";
    $("summary").replaceChildren(
      "Ladybugg just finished checking ",
      Object.assign(document.createElement("strong"), { textContent: details.host }),
      ", and it isn't safe. Don't enter passwords or payment details, or download anything from it.",
    );
  }
  card.hidden = false;
  exitEl.focus();

  const ladybug = startLadybug();
  if (!ladybug || prefersReducedMotion()) return;
  // Wings flare and the shell flashes as the warning appears, and again if
  // the pointer heads for "Continue anyway".
  setTimeout(() => ladybug.alarm(), 250);
  let lastAlarm = 0;
  const fret = () => {
    if (performance.now() - lastAlarm < 2_000) return;
    lastAlarm = performance.now();
    ladybug.startle();
    ladybug.alarm();
  };
  continueEl.addEventListener("pointerenter", fret);
  continueEl.addEventListener("focus", fret);
}

async function init() {
  if (asPage) {
    document.documentElement.dataset.mode = "page";
    document.body.classList.add("garden-sky");
    document.title = "Unsafe page blocked · Ladybugg";
  }
  const details = token ? await send("warning:get").catch(() => null) : null;
  if (!details) {
    // Dismissed already, or framed by something other than the extension.
    document.body.hidden = true;
    return;
  }
  show(details);

  const act = (type: "warning:exit" | "warning:continue") => {
    exitEl.disabled = continueEl.disabled = true;
    void send(type).finally(() => {
      exitEl.disabled = continueEl.disabled = false;
    });
  };
  exitEl.addEventListener("click", () => act("warning:exit"));
  continueEl.addEventListener("click", () => act("warning:continue"));
}

void init();
