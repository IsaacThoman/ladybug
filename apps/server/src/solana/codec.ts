// Borsh encoding for the computerbug_verdicts program, by hand from
// docs/solana.md: no IDL, no Anchor client.
import { createHash } from "node:crypto";
import type { ReportVerdict, ScanVerdict } from "@ladybug/shared";

export const MAX_HOST_BYTES = 253;

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest();

/** Anchor's instruction discriminator: sha256("global:<name>")[..8]. */
export const instructionDiscriminator = (name: string) => sha256(`global:${name}`).subarray(0, 8);

/** Anchor's account discriminator: sha256("account:<Name>")[..8]. */
export const accountDiscriminator = (name: string) => sha256(`account:${name}`).subarray(0, 8);

/** SHA-256 of the normalised host, the Site PDA's seed. */
export const hostHash = (host: string) => sha256(host);

/** SHA-256 of the normalised URL: full URLs never go on-chain. */
export const urlHash = (url: string) => sha256(url);

/** SHA-256 of a scan report's JSON. */
export const reportHash = (report: unknown) => sha256(JSON.stringify(report));

export const SCAN_VERDICT_CODES = { benign: 1, suspicious: 2, malicious: 3 } as const satisfies Record<ScanVerdict, number>;
export const REPORT_VERDICT_CODES = { safe: 1, unsafe: 2 } as const satisfies Record<ReportVerdict, number>;

const SCAN_VERDICTS: (ScanVerdict | null)[] = [null, "benign", "suspicious", "malicious"];

/** Appends Borsh values to a byte list. */
function writer() {
  const parts: Uint8Array[] = [];
  const self = {
    bytes(value: Uint8Array, length?: number) {
      if (length !== undefined && value.length !== length) throw new Error(`expected ${length} bytes, got ${value.length}`);
      parts.push(value);
      return self;
    },
    u8(value: number) {
      if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`${value} is not a u8`);
      parts.push(Uint8Array.of(value));
      return self;
    },
    string(value: string) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      parts.push(length, bytes);
      return self;
    },
    done: () => Buffer.concat(parts),
  };
  return self;
}

function checkHost(host: string) {
  if (Buffer.byteLength(host, "utf8") > MAX_HOST_BYTES) throw new Error(`host is longer than ${MAX_HOST_BYTES} bytes`);
}

export const encodeInitialize = (authority: Uint8Array) =>
  writer().bytes(instructionDiscriminator("initialize")).bytes(authority, 32).done();

export function encodeRecordScan(args: { host: string; verdict: ScanVerdict; score: number; reportHash: Uint8Array }) {
  checkHost(args.host);
  return writer()
    .bytes(instructionDiscriminator("record_scan"))
    .bytes(hostHash(args.host), 32)
    .string(args.host)
    .u8(SCAN_VERDICT_CODES[args.verdict])
    .u8(Math.max(0, Math.min(100, Math.round(args.score))))
    .bytes(args.reportHash, 32)
    .done();
}

export function encodeSubmitReport(args: { host: string; verdict: ReportVerdict; urlHash: Uint8Array }) {
  checkHost(args.host);
  return writer()
    .bytes(instructionDiscriminator("submit_report"))
    .bytes(hostHash(args.host), 32)
    .string(args.host)
    .u8(REPORT_VERDICT_CODES[args.verdict])
    .bytes(args.urlHash, 32)
    .done();
}

/** A Config account's authority. Throws if it isn't one. */
export function decodeConfigAuthority(data: Uint8Array) {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!buffer.subarray(0, 8).equals(accountDiscriminator("Config"))) throw new Error("not a Config account");
  return buffer.subarray(8, 40);
}

/** A Site account's fields. */
export type SiteState = {
  host: string;
  safeReports: number;
  unsafeReports: number;
  /** null when no scan was recorded. */
  scan: { verdict: ScanVerdict; score: number; reportHash: string; scannedAt: string } | null;
};

/** Reads a Site account's data. Throws if it isn't one. */
export function decodeSite(data: Uint8Array): SiteState {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!buffer.subarray(0, 8).equals(accountDiscriminator("Site"))) throw new Error("not a Site account");
  let offset = 8 + 32;
  const hostLength = buffer.readUInt32LE(offset);
  offset += 4;
  if (hostLength > MAX_HOST_BYTES) throw new Error("Site host is too long");
  const host = buffer.toString("utf8", offset, offset + hostLength);
  offset += hostLength;
  const safeReports = buffer.readUInt32LE(offset);
  const unsafeReports = buffer.readUInt32LE(offset + 4);
  const verdict = SCAN_VERDICTS[buffer.readUInt8(offset + 8)] ?? null;
  const score = buffer.readUInt8(offset + 9);
  const hash = buffer.toString("hex", offset + 10, offset + 42);
  const scannedAt = Number(buffer.readBigInt64LE(offset + 42));
  return {
    host,
    safeReports,
    unsafeReports,
    scan:
      verdict && scannedAt > 0
        ? { verdict, score, reportHash: hash, scannedAt: new Date(scannedAt * 1000).toISOString() }
        : null,
  };
}
