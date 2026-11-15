import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  BPF_LOADER_UPGRADEABLE,
  base58Decode,
  configAddress,
  explorerUrl,
  initializeInstruction,
  parseKeypair,
  programDataAddress,
  recordScanInstruction,
  reportAddress,
  reporterKeypair,
  siteAddress,
  submitReportInstruction,
} from "./program.ts";

const PROGRAM = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

test("PDAs follow the documented seeds", () => {
  const hash = createHash("sha256").update("example.com").digest();
  assert.ok(siteAddress(PROGRAM, "example.com").equals(PublicKey.findProgramAddressSync([Buffer.from("site"), hash], PROGRAM)[0]));
  assert.ok(siteAddress(PROGRAM, "example.com").equals(siteAddress(PROGRAM, "example.com")));
  assert.ok(!siteAddress(PROGRAM, "example.com").equals(siteAddress(PROGRAM, "example.org")));
  assert.ok(configAddress(PROGRAM).equals(PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM)[0]));

  const site = siteAddress(PROGRAM, "example.com");
  const reporter = Keypair.generate().publicKey;
  assert.ok(
    reportAddress(PROGRAM, site, reporter).equals(
      PublicKey.findProgramAddressSync([Buffer.from("report"), site.toBuffer(), reporter.toBuffer()], PROGRAM)[0],
    ),
  );
  assert.ok(
    programDataAddress(PROGRAM).equals(PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], BPF_LOADER_UPGRADEABLE)[0]),
  );
});

test("reporter keys are stable per account and differ between accounts", () => {
  const a = reporterKeypair("secret", "11111111-1111-4111-8111-111111111111");
  assert.ok(a.publicKey.equals(reporterKeypair("secret", "11111111-1111-4111-8111-111111111111").publicKey));
  assert.ok(!a.publicKey.equals(reporterKeypair("secret", "22222222-2222-4222-8222-222222222222").publicKey));
  assert.ok(!a.publicKey.equals(reporterKeypair("other", "11111111-1111-4111-8111-111111111111").publicKey));
  // The ed25519 seed is HMAC-SHA256("secret", "reporter:<id>").
  assert.equal(
    Buffer.from(a.secretKey.subarray(0, 32)).toString("hex"),
    "6fa4f7cfad9862a3707a53d9724827075e9f758a50b16a3da98b0933d52d8e43",
  );
});

test("the authority key parses as a JSON byte array or base58", () => {
  const key = Keypair.generate();
  assert.ok(parseKeypair(JSON.stringify([...key.secretKey])).publicKey.equals(key.publicKey));
  assert.ok(parseKeypair(`  ${JSON.stringify([...key.secretKey])}\n`).publicKey.equals(key.publicKey));
  // Base58 of the 64-byte secret key, as wallets export it.
  const base58 = encodeBase58(key.secretKey);
  assert.deepEqual(base58Decode(base58), key.secretKey);
  assert.ok(parseKeypair(base58).publicKey.equals(key.publicKey));
  assert.deepEqual(base58Decode(key.publicKey.toBase58()), key.publicKey.toBytes());
  assert.throws(() => parseKeypair("[1,2,3]"), /64-byte/);
  assert.throws(() => parseKeypair("[1,2,999]"));
  assert.throws(() => parseKeypair("not base58 0OIl"));
});

test("instructions list accounts in the documented order", () => {
  const authority = Keypair.generate().publicKey;
  const reporter = Keypair.generate().publicKey;
  const site = siteAddress(PROGRAM, "example.com");
  const flags = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) =>
    keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);

  assert.deepEqual(flags(initializeInstruction(PROGRAM, authority, authority).keys), [
    [configAddress(PROGRAM).toBase58(), false, true],
    [authority.toBase58(), true, true],
    [PROGRAM.toBase58(), false, false],
    [programDataAddress(PROGRAM).toBase58(), false, false],
    [SystemProgram.programId.toBase58(), false, false],
  ]);

  const scan = recordScanInstruction(PROGRAM, authority, {
    host: "example.com",
    verdict: "benign",
    score: 3,
    reportHash: Buffer.alloc(32),
  });
  assert.ok(scan.programId.equals(PROGRAM));
  assert.deepEqual(flags(scan.keys), [
    [configAddress(PROGRAM).toBase58(), false, false],
    [site.toBase58(), false, true],
    [authority.toBase58(), true, true],
    [SystemProgram.programId.toBase58(), false, false],
  ]);

  const report = submitReportInstruction(PROGRAM, authority, reporter, {
    host: "example.com",
    verdict: "safe",
    urlHash: Buffer.alloc(32),
  });
  assert.deepEqual(flags(report.keys), [
    [configAddress(PROGRAM).toBase58(), false, false],
    [site.toBase58(), false, true],
    [reportAddress(PROGRAM, site, reporter).toBase58(), false, true],
    [reporter.toBase58(), true, false],
    [authority.toBase58(), true, true],
    [SystemProgram.programId.toBase58(), false, false],
  ]);
});

test("Explorer links name the cluster", () => {
  assert.equal(explorerUrl("devnet", "", "address", "abc"), "https://explorer.solana.com/address/abc?cluster=devnet");
  assert.equal(explorerUrl("testnet", "", "tx", "sig"), "https://explorer.solana.com/tx/sig?cluster=testnet");
  assert.equal(explorerUrl("mainnet-beta", "", "tx", "sig"), "https://explorer.solana.com/tx/sig");
  assert.equal(
    explorerUrl("localnet", "http://127.0.0.1:8899", "address", "abc"),
    "https://explorer.solana.com/address/abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899",
  );
});

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes: Uint8Array) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let text = "";
  for (; value > 0n; value /= 58n) text = ALPHABET[Number(value % 58n)] + text;
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}
