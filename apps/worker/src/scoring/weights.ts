// Every scoring knob in one place, so they can be tuned against the test set.

export const FLOORS = {
  /** Listed by Safe Browsing or URLhaus. */
  knownBadReputation: 90,
  /** A downloaded file matched a known-bad hash. */
  knownBadHash: 90,
  /** Fake CAPTCHA that put a shell command on the clipboard ("ClickFix"). Unambiguous, even without the LLM. */
  clipboardCommand: 85,
} as const;

export const WEIGHTS = {
  credentialFormCrossDomain: 25,
  brandLookalike: 20,
  youngDomain: 15,
  cloaking: 15,
  abusiveBehaviour: 15,
  obfuscation: 10,
  promptInjection: 20,
  /** The page's fingerprint is a near match for a page we already flagged. Suspicious on its own. */
  similarKnownBad: 30,
} as const;

export const THRESHOLDS = {
  youngDomainDays: 30,
  /** Word-set similarity between desktop and mobile text below which we call it cloaking. */
  cloakingTextSimilarity: 0.25,
  /** Both versions need this many distinct words before text similarity means anything. */
  cloakingMinWords: 40,
  /** eval / new Function / string-timer calls before we call it obfuscated. */
  dynamicCodeCalls: 3,
  /** A single atob / unescape / fromCharCode payload this large is suspicious. */
  largeDecodeChars: 5_000,
  /** Cosine similarity of page fingerprints at or above which two pages count as the same kit. */
  similarPage: 0.85,
};

/** final = max(floors, round(SIGNAL_SHARE * signalScore + (1 - SIGNAL_SHARE) * llmScore)) */
export const SIGNAL_SHARE = 0.5;
