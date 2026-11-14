// A page fingerprint: the page's words, word pairs and form shape, hashed into
// a fixed-length vector (the "hashing trick"). Phishing kits are copied
// verbatim from site to site, so two pages from the same kit land close
// together in cosine distance however their domains differ. Deterministic and
// local: no embedding model or API key needed.
import { FINGERPRINT_DIMENSIONS } from "@ladybug/backend";
import type { DomSnapshot } from "@ladybug/shared";

/** Pages with fewer distinct words than this get no fingerprint: blank and error pages all look alike. */
export const MIN_FINGERPRINT_WORDS = 20;

const TITLE_WEIGHT = 2;
const FORM_WEIGHT = 1.5;

const words = (text: string) => text.toLowerCase().match(/\p{L}{3,}/gu) ?? [];

/** 32-bit FNV-1a. */
function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function features(dom: DomSnapshot) {
  const counts = new Map<string, number>();
  const add = (feature: string, weight = 1) => counts.set(feature, (counts.get(feature) ?? 0) + weight);
  const addText = (list: string[], weight: number) => {
    list.forEach((word, i) => {
      add(`w:${word}`, weight);
      if (i > 0) add(`b:${list[i - 1]} ${word}`, weight);
    });
  };
  addText(words(dom.title), TITLE_WEIGHT);
  addText(words(dom.text), 1);
  for (const form of dom.forms) {
    add(`f:${form.method.toLowerCase()}${form.hasPasswordField ? ":password" : ""}`, FORM_WEIGHT);
    for (const input of form.inputs) {
      const name = (input.name ?? "").toLowerCase().replace(/[^a-z]+/g, "");
      add(`i:${input.type.toLowerCase()}:${name}`, FORM_WEIGHT);
    }
  }
  return counts;
}

/**
 * The page's fingerprint, L2-normalised so cosine similarity is a dot
 * product. null when there's too little text to say anything.
 */
export function pageFingerprint(dom: DomSnapshot | null, dimensions = FINGERPRINT_DIMENSIONS): number[] | null {
  if (!dom) return null;
  if (new Set(words(`${dom.title} ${dom.text}`)).size < MIN_FINGERPRINT_WORDS) return null;

  const vector = new Array<number>(dimensions).fill(0);
  for (const [feature, count] of features(dom)) {
    const hash = fnv1a(feature);
    // A second bit of the hash picks the sign, so collisions cancel out rather than pile up.
    const sign = Math.imul(hash, 0x9e3779b1) >>> 31 ? -1 : 1;
    vector[hash % dimensions] += sign * (1 + Math.log(count));
  }
  const norm = Math.hypot(...vector);
  return norm === 0 ? null : vector.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
