import { setTimeout as sleep } from "node:timers/promises";
import type { SandboxFile } from "@ladybug/shared";
import type { ScanContext } from "../context.ts";
import type { Evidence } from "../evidence.ts";
import { malwareBazaar } from "../prescan/reputation.ts";
import type { DaemonClient } from "../sandbox/client.ts";

const NAV_TIMEOUT_MS = 30_000;

/** Looks up every downloaded file not checked yet. */
export async function checkDownloads(ev: Evidence, files: SandboxFile[]) {
  const checked = new Set(ev.hashHits.map((h) => h.sha256));
  const downloads = files.filter((f) => f.source === "download" && !checked.has(f.sha256));
  const results = await Promise.all(downloads.map(async (f) => ({ f, hit: await malwareBazaar(f.sha256) })));
  for (const { f, hit } of results) if (hit) ev.hashHits.push({ path: f.path, sha256: f.sha256, hit });
}

/**
 * Scripted baseline, no LLM: load the page, screenshot it 0/3/10 s after load, grab
 * DOM / requests / behaviour / downloads, then reload as a phone to catch
 * cheap cloaking. Leaves the sandbox on a fresh desktop profile and returns
 * the last desktop screenshot for the agent.
 */
export async function detonate(ctx: ScanContext, sandbox: DaemonClient, ev: Evidence): Promise<Buffer | null> {
  const nav = await sandbox.navigate({ url: ev.inputUrl, waitUntil: "load", timeoutMs: NAV_TIMEOUT_MS });
  const loadedAt = Date.now();
  ev.navigation = nav;
  if (nav.error) {
    await ctx.emit({ type: "agent_note", text: `Navigation problem: ${nav.error}` });
    if (!nav.status) ev.flags.push("navigation_failed");
  }
  await ctx.emit({ type: "redirect_chain", chain: nav.redirectChain });

  let lastShot: Buffer | null = null;
  for (const [label, atMs] of [
    ["t+0s", 0],
    ["t+3s", 3_000],
    ["t+10s", 10_000],
  ] as const) {
    const wait = loadedAt + atMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      lastShot = await sandbox.screenshot();
      ev.screenshots.push(await ctx.addScreenshot(lastShot, label));
    } catch (err) {
      console.warn(`[worker] ${ctx.scanId}: screenshot ${label} failed`, err);
    }
  }

  const [dom, requests, events, files, har] = await Promise.all([
    sandbox.dom().catch(() => null),
    sandbox.requests().catch(() => ({ requests: [] })),
    sandbox.events().catch(() => null),
    sandbox.files().catch(() => ({ files: [] })),
    sandbox.har().catch(() => null),
  ]);
  ev.dom = dom;
  ev.baselineRequests = ev.requests = requests.requests;
  ev.baselineEvents = ev.events = events;
  ev.baselineFiles = ev.files = files.files;

  await Promise.all([
    dom && ctx.putArtifact("baseline/dom.html.txt", dom.html, "text/plain; charset=utf-8"),
    har && ctx.putArtifact("baseline/requests.har", har, "application/json"),
    events && ctx.putArtifact("baseline/events.json", JSON.stringify(events, null, 2), "application/json"),
    checkDownloads(ev, files.files),
  ]);

  try {
    await sandbox.setContext(true);
    const mobileNav = await sandbox.navigate({ url: ev.inputUrl, waitUntil: "load", timeoutMs: NAV_TIMEOUT_MS });
    await sleep(2_000);
    ev.screenshots.push(await ctx.addScreenshot(await sandbox.screenshot(), "mobile"));
    ev.mobile = { navigation: mobileNav, dom: await sandbox.dom().catch(() => null) };
  } catch (err) {
    console.warn(`[worker] ${ctx.scanId}: mobile pass failed`, err);
  } finally {
    await sandbox.setContext(false).catch(() => {});
  }
  return lastShot;
}
