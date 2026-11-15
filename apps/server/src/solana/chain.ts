// The server's side of the computerbug_verdicts program: it signs every
// community report (with the reporter's derived key) and every scan verdict,
// and pays for them.
import { Connection, PublicKey, Transaction, TransactionExpiredBlockheightExceededError } from "@solana/web3.js";
import type { Keypair, TransactionInstruction } from "@solana/web3.js";
import type { ReportVerdict, ScanVerdict, SiteChainInfo, SolanaCluster } from "@ladybug/shared";
import type { SolanaSettings } from "../config.ts";
import { decodeConfigAuthority, decodeSite } from "./codec.ts";
import type { SiteState } from "./codec.ts";
import {
  configAddress,
  explorerUrl,
  initializeInstruction,
  parseKeypair,
  recordScanInstruction,
  reporterKeypair,
  siteAddress,
  submitReportInstruction,
} from "./program.ts";

/** The RPC calls the chain client makes, so tests can fake them. */
export type ChainConnection = Pick<
  Connection,
  "getAccountInfo" | "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction"
>;

/** What the reports routes and the analyzer need from the chain. */
export type ReportChain = Pick<SolanaChain, "siteInfo" | "txUrl" | "readSite" | "submitReport" | "recordScan">;

const SITE_CACHE_MS = 15_000;
const SITE_CACHE_MAX = 1_000;
const INIT_RETRY_MS = 60_000;

/** Config names a different authority: every write would be refused. */
export class AuthorityMismatchError extends Error {}

const isExpired = (err: unknown) =>
  err instanceof TransactionExpiredBlockheightExceededError ||
  (err instanceof Error && /blockhash not found|block height exceeded/i.test(err.message));

export class SolanaChain {
  readonly cluster: SolanaCluster;
  readonly programId: PublicKey;
  readonly authority: Keypair;
  private readonly rpcUrl: string;
  private readonly reporterSecret: string;
  private readonly connection: ChainConnection;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly sites = new Map<string, { expires: number; value: Promise<SiteState | null> }>();

  constructor(settings: SolanaSettings, connection?: ChainConnection) {
    this.cluster = settings.cluster;
    this.rpcUrl = settings.rpcUrl;
    this.programId = new PublicKey(settings.programId);
    this.authority = parseKeypair(settings.authorityKey);
    this.reporterSecret = settings.reporterSecret;
    this.connection = connection ?? new Connection(settings.rpcUrl, "confirmed");
  }

  siteInfo(host: string): SiteChainInfo {
    const address = siteAddress(this.programId, host).toBase58();
    return {
      cluster: this.cluster,
      programId: this.programId.toBase58(),
      siteAddress: address,
      explorerUrl: explorerUrl(this.cluster, this.rpcUrl, "address", address),
    };
  }

  txUrl(signature: string) {
    return explorerUrl(this.cluster, this.rpcUrl, "tx", signature);
  }

  reporter(accountId: string) {
    return reporterKeypair(this.reporterSecret, accountId);
  }

  /** The host's Site account, or null if nothing was written for it yet. Cached briefly. */
  readSite(host: string): Promise<SiteState | null> {
    const cached = this.sites.get(host);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (this.sites.size >= SITE_CACHE_MAX) this.sites.clear();
    const value = this.connection
      .getAccountInfo(siteAddress(this.programId, host))
      .then((info) => (info ? decodeSite(info.data) : null));
    this.sites.set(host, { expires: Date.now() + SITE_CACHE_MS, value });
    value.catch(() => this.sites.delete(host));
    return value;
  }

  /** Creates the Config account if it's missing. The authority key must be the program's upgrade authority. */
  async ensureInitialized(): Promise<"exists" | "initialized"> {
    const info = await this.connection.getAccountInfo(configAddress(this.programId));
    if (info) {
      const authority = new PublicKey(decodeConfigAuthority(info.data));
      if (!authority.equals(this.authority.publicKey)) {
        throw new AuthorityMismatchError(
          `the program's authority is ${authority.toBase58()}, not this server's key ${this.authority.publicKey.toBase58()}, so reports will be refused`,
        );
      }
      return "exists";
    }
    const key = this.authority.publicKey;
    await this.enqueue(() => this.send(initializeInstruction(this.programId, key, key), []));
    return "initialized";
  }

  /** Writes a scan verdict for the host. Resolves with the transaction signature once confirmed. */
  async recordScan(scan: { host: string; verdict: ScanVerdict; score: number; reportHash: Uint8Array }) {
    const signature = await this.enqueue(() =>
      this.send(recordScanInstruction(this.programId, this.authority.publicKey, scan), []),
    );
    this.sites.delete(scan.host);
    return signature;
  }

  /** Writes (or changes) one account's vote on a host. */
  async submitReport(report: { accountId: string; host: string; verdict: ReportVerdict; urlHash: Uint8Array }) {
    const reporter = this.reporter(report.accountId);
    const signature = await this.enqueue(() =>
      this.send(submitReportInstruction(this.programId, this.authority.publicKey, reporter.publicKey, report), [reporter]),
    );
    this.sites.delete(report.host);
    return signature;
  }

  /** One transaction at a time, so a changed vote lands after the one it replaces. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => {});
    return run;
  }

  /** Signs, sends and confirms. A blockhash that expired first gets one retry. */
  private async send(instruction: TransactionInstruction, signers: Keypair[]) {
    for (let attempt = 1; ; attempt++) {
      try {
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: this.authority.publicKey, blockhash, lastValidBlockHeight }).add(instruction);
        tx.sign(this.authority, ...signers);
        const signature = await this.connection.sendRawTransaction(tx.serialize());
        const { value } = await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        if (value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(value.err)}`);
        return signature;
      } catch (err) {
        if (attempt === 1 && isExpired(err)) continue;
        throw err;
      }
    }
  }
}

/**
 * The chain client for these settings, or null when Solana is off or
 * misconfigured. Checks the program's Config in the background, creating it if
 * needed; an unreachable RPC is logged and retried, never fatal.
 */
export function startChain(settings: SolanaSettings | null): SolanaChain | null {
  if (!settings) return null;
  let chain: SolanaChain;
  try {
    chain = new SolanaChain(settings);
  } catch (err) {
    console.error(`[solana] bad configuration, community reports stay in Postgres: ${(err as Error).message}`);
    return null;
  }
  let attempt = 0;
  const check = () => {
    attempt++;
    chain.ensureInitialized().then(
      (result) => {
        console.log(
          `[solana] ${result === "initialized" ? "initialised" : "using"} program ${chain.programId.toBase58()} on ${settings.cluster} (authority ${chain.authority.publicKey.toBase58()})`,
        );
      },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        if (err instanceof AuthorityMismatchError) {
          console.error(`[solana] ${reason}`);
          return;
        }
        if (attempt === 1 || attempt % 10 === 0) {
          console.warn(`[solana] checking the program's config failed (${reason}); retrying every ${INIT_RETRY_MS / 1000}s`);
        }
        setTimeout(check, INIT_RETRY_MS).unref();
      },
    );
  };
  check();
  return chain;
}
