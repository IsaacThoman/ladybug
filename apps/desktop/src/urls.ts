// URL helpers shared by the main process (clipboard, openExternal) and the
// renderer (dropped links). No DOM or Node imports.

/** The URL if `value` parses as an http(s) URL, otherwise null. */
export function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** First http(s) URL anywhere in a run of text. */
export function findHttpUrl(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    // Trailing punctuation usually belongs to the sentence, not the link.
    const url = parseHttpUrl(match[0].replace(/[).,;:!?\]]+$/, ""));
    if (url) return url;
  }
  return null;
}

// "example.com", "sub.example.co.uk/path?q=1", "example.com:8080".
const BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * Clipboard text as a URL to scan: an http(s) URL as-is, or a bare domain
 * with `https://` added. Anything else (prose, other schemes) is null.
 */
export function urlFromClipboardText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return parseHttpUrl(trimmed);
  return BARE_DOMAIN.test(trimmed) ? parseHttpUrl(`https://${trimmed}`) : null;
}
