/**
 * Who the main process places support calls as: the server the pet is signed
 * in to and that account's session token. The renderer owns the session and
 * hands it over whenever it signs in or out.
 */
export type CallAuth = { url: string; token: string };

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** The renderer's session, checked before the main process sends it anywhere; null when signed out. */
export function parseCallAuth(input: unknown): CallAuth | null {
  if (input === null) return null;
  const { url: rawUrl, token } = (input ?? {}) as Partial<Record<keyof CallAuth, unknown>>;
  if (typeof rawUrl !== "string" || typeof token !== "string" || !token.trim() || token.length > 512) {
    throw new Error("Invalid session.");
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Invalid server URL."); }
  const local = LOOPBACK.includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error("The server must use HTTPS, or HTTP on localhost for development.");
  }
  return { url: url.toString().replace(/\/$/, ""), token: token.trim() };
}
