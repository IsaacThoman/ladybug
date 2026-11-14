import { domainToUnicode } from "node:url";
import { parse } from "tldts";

/** Brands that phishing kits impersonate most, with the domains they really own. */
const BRANDS: Record<string, string[]> = {
  paypal: ["paypal.com"],
  microsoft: ["microsoft.com", "live.com", "office.com", "microsoftonline.com", "outlook.com"],
  office365: ["office.com", "microsoft.com"],
  outlook: ["outlook.com", "live.com"],
  apple: ["apple.com", "icloud.com"],
  icloud: ["icloud.com", "apple.com"],
  google: ["google.com", "gmail.com", "youtube.com"],
  amazon: ["amazon.com", "amazon.co.uk", "amazon.de", "aws.amazon.com"],
  netflix: ["netflix.com"],
  facebook: ["facebook.com", "fb.com", "meta.com"],
  instagram: ["instagram.com"],
  whatsapp: ["whatsapp.com"],
  linkedin: ["linkedin.com"],
  dropbox: ["dropbox.com"],
  docusign: ["docusign.com", "docusign.net"],
  adobe: ["adobe.com"],
  coinbase: ["coinbase.com"],
  binance: ["binance.com"],
  metamask: ["metamask.io"],
  chase: ["chase.com"],
  wellsfargo: ["wellsfargo.com"],
  bankofamerica: ["bankofamerica.com"],
  citibank: ["citi.com", "citibank.com"],
  usps: ["usps.com"],
  fedex: ["fedex.com"],
  dhl: ["dhl.com"],
  steam: ["steampowered.com", "steamcommunity.com"],
  discord: ["discord.com", "discord.gg"],
  roblox: ["roblox.com"],
  irs: ["irs.gov"],
};

/** Characters that render like latin letters, folded to what they imitate. */
const HOMOGLYPHS: Record<string, string> = {
  "0": "o", "1": "l", "3": "e", "5": "s", "7": "t", "@": "a", "$": "s",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ԁ": "d", "ɡ": "g",
  "ο": "o", "α": "a", "ν": "v", "ι": "i", "κ": "k", "τ": "t",
};

export function skeleton(label: string) {
  let out = "";
  for (const ch of label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()) out += HOMOGLYPHS[ch] ?? ch;
  return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const scriptsOf = (text: string) => {
  const scripts = new Set<string>();
  for (const ch of text) {
    if (/\p{Script=Latin}/u.test(ch)) scripts.add("Latin");
    else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add("Cyrillic");
    else if (/\p{Script=Greek}/u.test(ch)) scripts.add("Greek");
    else if (/\p{L}/u.test(ch)) scripts.add("Other");
  }
  return scripts;
};

/**
 * Cheap look-alike check on a hostname: punycode, mixed scripts, and brand
 * names inside (or one edit away from) a domain the brand doesn't own.
 * Returns a human-readable note, or null.
 */
export function checkLookalike(hostname: string): string | null {
  const parsed = parse(hostname);
  const domain = parsed.domain;
  if (!domain) return null;
  const notes: string[] = [];

  const unicode = domainToUnicode(hostname);
  if (hostname.split(".").some((label) => label.startsWith("xn--"))) {
    notes.push(`punycode hostname (displays as ${unicode})`);
    if (scriptsOf(unicode.replace(/\./g, "")).size > 1) notes.push("mixes alphabets");
  }

  // Look at every label left of the public suffix, e.g. paypal.com.secure-login.xyz.
  const labels = (parsed.subdomain ? `${parsed.subdomain}.` : "") + (parsed.domainWithoutSuffix ?? "");
  const tokens = domainToUnicode(labels)
    .split(/[.-]/)
    .filter(Boolean)
    .map(skeleton);
  const joined = tokens.join("");

  for (const [brand, owned] of Object.entries(BRANDS)) {
    if (owned.some((d) => domain === d || hostname.endsWith(`.${d}`))) continue;
    const hit =
      tokens.some((t) => t === brand || (brand.length >= 5 && t.length >= 4 && editDistance(t, brand) === 1)) ||
      (brand.length >= 5 && joined.includes(brand));
    if (hit) {
      notes.push(`references "${brand}" but isn't on ${owned[0]}`);
      break;
    }
  }

  return notes.length > 0 ? notes.join("; ") : null;
}
