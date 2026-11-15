import type { ApiError, CommunityTally, CreateReportRequest, ReportVerdict } from "@ladybug/shared";
import { setAuth } from "./settings";
import type { Auth } from "./settings";

// Community reports (docs/solana.md): what signed-in people say about a site.
// Shared by the popup and the warning page.

const TIMEOUT_MS = 10_000;

/** Keeps the stored account in line with what the server said about it. */
async function noteAccountError(auth: Auth, body: Partial<ApiError>) {
  if (body.code === "signed_out") await setAuth(null);
  else if ((body.code === "pending" || body.code === "rejected") && auth.account.status !== body.code) {
    await setAuth({ ...auth, account: { ...auth.account, status: body.code } });
  }
}

async function call(serverUrl: string, auth: Auth, path: string, init?: RequestInit): Promise<CommunityTally> {
  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}`, ...init?.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as CommunityTally | Partial<ApiError>;
  if (!res.ok) {
    const error = body as Partial<ApiError>;
    await noteAccountError(auth, error);
    throw new Error(error.error ?? `Request failed (${res.status})`);
  }
  return body as CommunityTally;
}

export const getTally = (serverUrl: string, auth: Auth, url: string) =>
  call(serverUrl, auth, `/api/reports?url=${encodeURIComponent(url)}`);

export function submitReport(serverUrl: string, auth: Auth, url: string, verdict: ReportVerdict) {
  const body: CreateReportRequest = { url, verdict };
  return call(serverUrl, auth, "/api/reports", { method: "POST", body: JSON.stringify(body) });
}

/** "3 say unsafe · 1 says safe". */
export function describeTally({ safe, unsafe }: Pick<CommunityTally, "safe" | "unsafe">) {
  if (safe + unsafe === 0) return "No reports yet";
  const part = (n: number, verdict: ReportVerdict) => `${n} ${n === 1 ? "says" : "say"} ${verdict}`;
  return [unsafe > 0 && part(unsafe, "unsafe"), safe > 0 && part(safe, "safe")].filter(Boolean).join(" · ");
}

/** Where to see the user's vote on-chain: the vote's transaction once confirmed, else the site account. */
export function chainLink(tally: CommunityTally): { text: string; href: string | null } | null {
  if (!tally.chain || !tally.mine) return null;
  if (tally.mine.chainStatus === "pending") return { text: "Recording on Solana…", href: null };
  if (tally.mine.chainStatus === "confirmed") {
    return { text: "Recorded on Solana ↗", href: tally.mine.explorerUrl ?? tally.chain.explorerUrl };
  }
  return null;
}
