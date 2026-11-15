// Addresses, keys and instructions for the computerbug_verdicts program
// (docs/solana.md).
import { createHmac } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { ReportVerdict, ScanVerdict, SolanaCluster } from "@ladybug/shared";
import { encodeInitialize, encodeRecordScan, encodeSubmitReport, hostHash } from "./codec.ts";

export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(text: string) {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("not base58");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; value > 0n; value >>= 8n) bytes.unshift(Number(value & 0xffn));
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** A keypair as `solana-keygen` writes it (a JSON byte array), or base58. */
export function parseKeypair(raw: string) {
  const text = raw.trim();
  let bytes: Uint8Array;
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("expected an array of bytes");
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    bytes = base58Decode(text);
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`expected a 64-byte secret key, got ${bytes.length} bytes`);
}

/** Each account's reporter key: ed25519 seed = HMAC-SHA256(secret, "reporter:" + accountId). */
export const reporterKeypair = (secret: string, accountId: string) =>
  Keypair.fromSeed(createHmac("sha256", secret).update(`reporter:${accountId}`).digest());

export const configAddress = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];

export const siteAddress = (programId: PublicKey, host: string) =>
  PublicKey.findProgramAddressSync([Buffer.from("site"), hostHash(host)], programId)[0];

export const reportAddress = (programId: PublicKey, site: PublicKey, reporter: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("report"), site.toBuffer(), reporter.toBuffer()], programId)[0];

export const programDataAddress = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];

const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isSigner, isWritable });

export function initializeInstruction(programId: PublicKey, payer: PublicKey, authority: PublicKey) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configAddress(programId), true),
      meta(payer, true, true),
      meta(programId, false),
      meta(programDataAddress(programId), false),
      meta(SystemProgram.programId, false),
    ],
    data: encodeInitialize(authority.toBytes()),
  });
}

export function recordScanInstruction(
  programId: PublicKey,
  authority: PublicKey,
  scan: { host: string; verdict: ScanVerdict; score: number; reportHash: Uint8Array },
) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configAddress(programId), false),
      meta(siteAddress(programId, scan.host), true),
      meta(authority, true, true),
      meta(SystemProgram.programId, false),
    ],
    data: encodeRecordScan(scan),
  });
}

export function submitReportInstruction(
  programId: PublicKey,
  authority: PublicKey,
  reporter: PublicKey,
  report: { host: string; verdict: ReportVerdict; urlHash: Uint8Array },
) {
  const site = siteAddress(programId, report.host);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configAddress(programId), false),
      meta(site, true),
      meta(reportAddress(programId, site, reporter), true),
      meta(reporter, false, true),
      meta(authority, true, true),
      meta(SystemProgram.programId, false),
    ],
    data: encodeSubmitReport(report),
  });
}

/** Solana Explorer link for an address or a transaction. */
export function explorerUrl(cluster: SolanaCluster, rpcUrl: string, kind: "address" | "tx", id: string) {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (cluster === "mainnet-beta") return base;
  if (cluster === "localnet") return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  return `${base}?cluster=${cluster}`;
}
