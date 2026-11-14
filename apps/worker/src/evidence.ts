import type {
  BrowserEvents,
  Confidence,
  DomainInfo,
  DomSnapshot,
  Finding,
  NavigateResponse,
  ReportFlag,
  RequestRecord,
  SandboxFile,
  Screenshot,
  SimilarPage,
} from "@ladybug/shared";
import type { ReputationHit } from "./prescan/reputation.ts";

/** What the agent hands back through submit_report. */
export type AgentAssessment = {
  llmScore: number;
  confidence: Confidence;
  categories: string[];
  summary: string;
  brandImpersonation: { brand: string; evidence: string } | null;
  promptInjectionAttempted: boolean;
  iocs: { domains: string[]; ips: string[]; urls: string[]; sha256: string[] };
};

/** Everything a scan collects. Scoring reads only this. */
export type Evidence = {
  scanId: string;
  inputUrl: string;
  startedAt: string;
  domain: DomainInfo | null;
  reputationHits: ReputationHit[];
  hashHits: { path: string; sha256: string; hit: ReputationHit }[];
  navigation: NavigateResponse | null;
  dom: DomSnapshot | null;
  /** Requests / events / files from the scripted baseline, before the agent touched anything. */
  baselineRequests: RequestRecord[];
  baselineEvents: BrowserEvents | null;
  baselineFiles: SandboxFile[];
  mobile: { navigation: NavigateResponse; dom: DomSnapshot | null } | null;
  /** Final state after the agent ran (same as baseline if it didn't). */
  requests: RequestRecord[];
  events: BrowserEvents | null;
  files: SandboxFile[];
  screenshots: Screenshot[];
  findings: Finding[];
  /** Categories the agent attached to findings. */
  findingCategories: string[];
  agent: AgentAssessment | null;
  /** Earlier flagged pages whose fingerprint is close to this one (pgvector). */
  similar: SimilarPage[];
  flags: ReportFlag[];
};

export function newEvidence(scanId: string, inputUrl: string): Evidence {
  return {
    scanId,
    inputUrl,
    startedAt: new Date().toISOString(),
    domain: null,
    reputationHits: [],
    hashHits: [],
    navigation: null,
    dom: null,
    baselineRequests: [],
    baselineEvents: null,
    baselineFiles: [],
    mobile: null,
    requests: [],
    events: null,
    files: [],
    screenshots: [],
    findings: [],
    findingCategories: [],
    agent: null,
    similar: [],
    flags: [],
  };
}
