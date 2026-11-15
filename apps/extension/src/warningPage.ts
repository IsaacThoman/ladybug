import { LadybugRenderer } from "@ladybug/mascot";
import { readServerSentEvents } from "@ladybug/shared";
import type { OpenWarningRequest, WarningStreamEvents } from "@ladybug/shared";
import { getAuth, getSettings } from "./settings";
import type { WarningDetails, WarningMessage } from "./warning";
import "@ladybug/mascot/garden.css";
import "./warning.css";

// The page that blocks an unsafe site: framed by the overlay (overlay.ts), or
// the whole tab. Its URL only carries a token; the details come from the
// background worker.
//
// While it's up, it keeps a stream open to the server, so the user's desktop
// ladybug stays scared and can offer the options in its speech bubble. If no
// desktop ladybug is listening, this page's own ladybug offers them instead.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Wait this long to hear whether a desktop ladybug is listening, before showing the options here. */
const HANDOFF_WAIT_MS = 1_500;
const RECONNECT_MS = 5_000;

const token = location.hash.slice(1);
/** Shown as the whole tab, rather than framed over the page (see the "page" warning mode). */
const asPage = new URLSearchParams(location.search).has("page");
const main = document.querySelector<HTMLElement>(".blocked")!;
const handoffEl = $("handoff");
const hereEl = $("here");
const exitEl = $<HTMLButtonElement>("exit");
const continueEl = $<HTMLButtonElement>("continue");

const send = (type: WarningMessage["type"]) =>
  chrome.runtime.sendMessage<WarningMessage, WarningDetails>({ type, token });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

/** Brings out this page's ladybug and its speech bubble. */
function speakHere() {
  const ladybug = startLadybug();
  if (!ladybug || prefersReducedMotion()) return;
  // Wings flare and the shell flashes as it starts talking, and again if
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

/**
 * "waiting": not yet known whether a desktop ladybug is listening. "handoff":
 * one is, and has the options. "here": this page shows them, and keeps doing
 * so once it has, so the buttons never vanish from under the user.
 */
let view: "waiting" | "handoff" | "here" = "waiting";

function setView(next: "handoff" | "here") {
  if (view === "here" || view === next) return;
  view = next;
  handoffEl.hidden = next !== "handoff";
  hereEl.hidden = next !== "here";
  if (next === "here") {
    speakHere();
    exitEl.focus();
  }
}

function show(details: NonNullable<WarningDetails>) {
  $("host").textContent = details.host;
  $("reason").textContent = details.reason;
  $("url").textContent = details.url;
  $("url").title = details.url;
  if (details.late) {
    $("summary").replaceChildren(
      "Ladybugg just finished checking ",
      Object.assign(document.createElement("strong"), { textContent: details.host }),
      ", and it isn't safe, so it's blocked now.",
    );
    $("speech-title").textContent = "This page turned out to be dangerous";
    $("speech-summary").textContent = "Don't enter passwords or payment details, or download anything from it.";
  }
  main.hidden = false;
  main.focus();
  $("show-here").addEventListener("click", () => setView("here"));
}

const act = (type: "warning:exit" | "warning:continue") => {
  exitEl.disabled = continueEl.disabled = true;
  void send(type).finally(() => {
    exitEl.disabled = continueEl.disabled = false;
  });
};

/**
 * Keeps the server posted that this page is blocked, for as long as it's
 * open, and acts on what the user picks on their desktop ladybug.
 */
async function stayInTouch(details: NonNullable<WarningDetails>) {
  const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
  if (!auth) {
    setView("here");
    return;
  }
  const body: OpenWarningRequest = { url: details.url, host: details.host, reason: details.reason, late: details.late };
  for (;;) {
    try {
      const res = await fetch(`${settings.serverUrl}/api/pet/warnings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify(body),
      });
      // An older server, or the account can't use it: no ladybug will hear.
      if (!res.ok || !res.body) {
        setView("here");
        return;
      }
      await readServerSentEvents(res.body, (event, data) => {
        if (event === "ready" || event === "pets") {
          const { pets } = JSON.parse(data) as WarningStreamEvents["pets"];
          setView(pets > 0 ? "handoff" : "here");
        } else if (event === "choice") {
          const { choice } = JSON.parse(data) as WarningStreamEvents["choice"];
          act(choice === "exit" ? "warning:exit" : "warning:continue");
        }
      });
    } catch {
      // Offline, or the server went away.
    }
    // Show the options here while out of touch, and keep trying so the
    // desktop ladybug hears about this page again when the server is back.
    setView("here");
    await sleep(RECONNECT_MS);
  }
}

async function init() {
  if (asPage) {
    document.documentElement.dataset.mode = "page";
    document.title = "Unsafe page blocked · Ladybugg";
  }
  const details = token ? await send("warning:get").catch(() => null) : null;
  if (!details) {
    // Dismissed already, or framed by something other than the extension.
    document.body.hidden = true;
    return;
  }
  show(details);
  exitEl.addEventListener("click", () => act("warning:exit"));
  continueEl.addEventListener("click", () => act("warning:continue"));
  setTimeout(() => {
    if (view === "waiting") setView("here");
  }, HANDOFF_WAIT_MS);
  void stayInTouch(details);
}

void init();
