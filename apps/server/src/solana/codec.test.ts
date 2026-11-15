import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountDiscriminator,
  decodeConfigAuthority,
  decodeSite,
  encodeInitialize,
  encodeRecordScan,
  encodeSubmitReport,
  hostHash,
  instructionDiscriminator,
  urlHash,
} from "./codec.ts";

const hex = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "hex");
const EXAMPLE_HASH = "a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947";

test("discriminators are Anchor's sha256 prefixes", () => {
  assert.equal(instructionDiscriminator("initialize").toString("hex"), "afaf6d1f0d989bed");
  assert.equal(instructionDiscriminator("record_scan").toString("hex"), "54694a62b850a5fd");
  assert.equal(instructionDiscriminator("submit_report").toString("hex"), "1bb24009142efa0e");
  assert.equal(accountDiscriminator("Site").toString("hex"), "8fff340f41a55e31");
  assert.equal(accountDiscriminator("Config").toString("hex"), "9b0caae01efacc82");
});

test("hosts and URLs hash with SHA-256", () => {
  assert.equal(hostHash("example.com").toString("hex"), EXAMPLE_HASH);
  assert.equal(
    urlHash("https://example.com/login").toString("hex"),
    "a461758d8f4e0782dfa6fe66b6cdd0023c6d6894d56b4866364795c211b780f0",
  );
});

test("submit_report encodes host_hash, host, verdict, url_hash", () => {
  const data = encodeSubmitReport({ host: "example.com", verdict: "unsafe", urlHash: Buffer.alloc(32, 0xab) });
  const expected = Buffer.concat([
    hex("1bb24009142efa0e"),
    hex(EXAMPLE_HASH),
    hex("0b000000"),
    Buffer.from("example.com"),
    hex("02"),
    Buffer.alloc(32, 0xab),
  ]);
  assert.equal(data.toString("hex"), expected.toString("hex"));
  assert.equal(data.length, 8 + 32 + 4 + 11 + 1 + 32);
  assert.equal(encodeSubmitReport({ host: "example.com", verdict: "safe", urlHash: Buffer.alloc(32) })[55], 1);
});

test("record_scan encodes host_hash, host, verdict, score, report_hash", () => {
  const data = encodeRecordScan({ host: "example.com", verdict: "malicious", score: 87, reportHash: Buffer.alloc(32, 0x11) });
  const expected = Buffer.concat([
    hex("54694a62b850a5fd"),
    hex(EXAMPLE_HASH),
    hex("0b000000"),
    Buffer.from("example.com"),
    hex("03 57"),
    Buffer.alloc(32, 0x11),
  ]);
  assert.equal(data.toString("hex"), expected.toString("hex"));
  const clamped = encodeRecordScan({ host: "a.b", verdict: "benign", score: 140.4, reportHash: Buffer.alloc(32) });
  assert.deepEqual([...clamped.subarray(47, 49)], [1, 100]);
});

test("initialize encodes the authority", () => {
  const authority = Buffer.alloc(32, 7);
  assert.equal(encodeInitialize(authority).toString("hex"), `afaf6d1f0d989bed${authority.toString("hex")}`);
  assert.throws(() => encodeInitialize(Buffer.alloc(31)));
});

test("hosts over 253 bytes are refused", () => {
  const host = `${"a".repeat(250)}.com`;
  assert.throws(() => encodeSubmitReport({ host, verdict: "safe", urlHash: Buffer.alloc(32) }), /253/);
});

/** A Site account, laid out as docs/solana.md describes it, padded to its full allocation. */
function siteAccount(fields: {
  host: string;
  safe: number;
  unsafe: number;
  verdict: number;
  score: number;
  reportHash: Buffer;
  scannedAt: bigint;
}) {
  const host = Buffer.from(fields.host);
  const tail = Buffer.alloc(4 + 4 + 1 + 1 + 32 + 8 + 1);
  tail.writeUInt32LE(fields.safe, 0);
  tail.writeUInt32LE(fields.unsafe, 4);
  tail.writeUInt8(fields.verdict, 8);
  tail.writeUInt8(fields.score, 9);
  fields.reportHash.copy(tail, 10);
  tail.writeBigInt64LE(fields.scannedAt, 42);
  tail.writeUInt8(254, 50);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(host.length);
  const body = Buffer.concat([hex("8fff340f41a55e31"), hostHash(fields.host), length, host, tail]);
  return Buffer.concat([body, Buffer.alloc(8 + 32 + 4 + 253 + 4 + 4 + 1 + 1 + 32 + 8 + 1 - body.length)]);
}

test("Site accounts decode", () => {
  const data = siteAccount({
    host: "example.com",
    safe: 4,
    unsafe: 70_000,
    verdict: 2,
    score: 55,
    reportHash: Buffer.alloc(32, 0xcd),
    scannedAt: 1_767_225_600n,
  });
  assert.deepEqual(decodeSite(data), {
    host: "example.com",
    safeReports: 4,
    unsafeReports: 70_000,
    scan: { verdict: "suspicious", score: 55, reportHash: "cd".repeat(32), scannedAt: "2026-01-01T00:00:00.000Z" },
  });

  const unscanned = siteAccount({ host: "new.example", safe: 1, unsafe: 0, verdict: 0, score: 0, reportHash: Buffer.alloc(32), scannedAt: 0n });
  assert.equal(decodeSite(unscanned).scan, null);
  // getAccountInfo hands back a Buffer that may be a slice of a bigger one.
  const offset = Buffer.concat([Buffer.alloc(5), unscanned]).subarray(5);
  assert.equal(decodeSite(offset).host, "new.example");

  assert.throws(() => decodeSite(Buffer.alloc(400)), /not a Site/);
});

test("Config accounts decode their authority", () => {
  const authority = Buffer.alloc(32, 9);
  assert.deepEqual(decodeConfigAuthority(Buffer.concat([hex("9b0caae01efacc82"), authority, hex("ff")])), authority);
  assert.throws(() => decodeConfigAuthority(Buffer.alloc(41)));
});
