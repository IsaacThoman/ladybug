import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, Transaction, TransactionExpiredBlockheightExceededError } from "@solana/web3.js";
import type { AccountInfo } from "@solana/web3.js";
import { solanaSettings } from "../config.ts";
import type { SolanaSettings } from "../config.ts";
import { SolanaChain } from "./chain.ts";
import type { ChainConnection } from "./chain.ts";
import { accountDiscriminator } from "./codec.ts";
import { configAddress } from "./program.ts";

const authority = Keypair.generate();
const settings: SolanaSettings = {
  rpcUrl: "http://127.0.0.1:8899",
  cluster: "localnet",
  programId: Keypair.generate().publicKey.toBase58(),
  authorityKey: JSON.stringify([...authority.secretKey]),
  reporterSecret: "test-secret",
};

test("Solana is on only when the RPC URL, program, authority key and reporter secret are all set", () => {
  const env = {
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    SOLANA_PROGRAM_ID: "prog",
    SOLANA_AUTHORITY_KEY: "[1,2]",
    SOLANA_REPORTER_SECRET: "s",
  };
  assert.deepEqual(solanaSettings(env), {
    rpcUrl: "https://api.devnet.solana.com",
    cluster: "devnet",
    programId: "prog",
    authorityKey: "[1,2]",
    reporterSecret: "s",
  });
  assert.equal(solanaSettings({}), null);
  for (const name of Object.keys(env)) assert.equal(solanaSettings({ ...env, [name]: "" }), null, name);
  assert.equal(solanaSettings({ ...env, SOLANA_RPC_URL: "  " }), null);
  assert.equal(solanaSettings({ ...env, SOLANA_CLUSTER: "mainnet-beta" })?.cluster, "mainnet-beta");
  assert.equal(solanaSettings({ ...env, SOLANA_CLUSTER: "localnet" })?.cluster, "localnet");
  assert.equal(solanaSettings({ ...env, SOLANA_CLUSTER: "moon" })?.cluster, "devnet");
});

test("a bad authority key or program id fails construction", () => {
  assert.throws(() => new SolanaChain({ ...settings, authorityKey: "[1,2,3]" }, {} as ChainConnection));
  assert.throws(() => new SolanaChain({ ...settings, programId: "nope" }, {} as ChainConnection));
});

function fakeConnection(options: { expireFirst?: boolean; account?: Buffer | null } = {}) {
  const sent: Transaction[] = [];
  let blockhashes = 0;
  let confirms = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  const connection: ChainConnection = {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: ++blockhashes,
    }),
    sendRawTransaction: async (raw) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sent.push(Transaction.from(raw as Buffer));
      return `sig${sent.length}`;
    },
    confirmTransaction: (async ({ signature }: { signature: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      if (options.expireFirst && confirms++ === 0) throw new TransactionExpiredBlockheightExceededError(signature);
      return { context: { slot: 1 }, value: { err: null } };
    }) as unknown as ChainConnection["confirmTransaction"],
    getAccountInfo: async () => {
      reads++;
      const data = options.account;
      return data ? ({ data, executable: false, lamports: 1, owner: authority.publicKey } as AccountInfo<Buffer>) : null;
    },
  };
  return { connection, sent, stats: () => ({ blockhashes, maxInFlight, reads }) };
}

test("reports are signed by the server and the account's reporter key, one at a time", async () => {
  const fake = fakeConnection();
  const chain = new SolanaChain(settings, fake.connection);
  const signatures = await Promise.all([
    chain.submitReport({ accountId: "a", host: "example.com", verdict: "unsafe", urlHash: Buffer.alloc(32) }),
    chain.submitReport({ accountId: "b", host: "example.com", verdict: "safe", urlHash: Buffer.alloc(32) }),
    chain.recordScan({ host: "example.com", verdict: "malicious", score: 90, reportHash: Buffer.alloc(32) }),
  ]);
  assert.deepEqual(signatures, ["sig1", "sig2", "sig3"]);
  assert.equal(fake.stats().maxInFlight, 1, "the queue sends one transaction at a time");
  const [first, , scan] = fake.sent;
  assert.ok(first.feePayer?.equals(authority.publicKey));
  assert.deepEqual(
    first.signatures.map((s) => s.publicKey.toBase58()).sort(),
    [authority.publicKey.toBase58(), chain.reporter("a").publicKey.toBase58()].sort(),
  );
  assert.ok(first.verifySignatures());
  assert.equal(scan.signatures.length, 1);
});

test("an expired blockhash is retried once", async () => {
  const fake = fakeConnection({ expireFirst: true });
  const chain = new SolanaChain(settings, fake.connection);
  const signature = await chain.recordScan({ host: "example.com", verdict: "benign", score: 0, reportHash: Buffer.alloc(32) });
  assert.equal(signature, "sig2");
  assert.equal(fake.stats().blockhashes, 2);
});

test("site reads are cached briefly; a write clears the cache", async () => {
  const fake = fakeConnection({ account: null });
  const chain = new SolanaChain(settings, fake.connection);
  assert.equal(await chain.readSite("example.com"), null);
  assert.equal(await chain.readSite("example.com"), null);
  assert.equal(fake.stats().reads, 1);
  await chain.submitReport({ accountId: "a", host: "example.com", verdict: "safe", urlHash: Buffer.alloc(32) });
  await chain.readSite("example.com");
  assert.equal(fake.stats().reads, 2);
});

test("startup creates the config only when it's missing, and checks its authority", async () => {
  const missing = fakeConnection({ account: null });
  const chain = new SolanaChain(settings, missing.connection);
  assert.equal(await chain.ensureInitialized(), "initialized");
  const [tx] = missing.sent;
  assert.ok(tx.instructions[0].keys[0].pubkey.equals(configAddress(chain.programId)));

  const config = (key: Uint8Array) => Buffer.concat([accountDiscriminator("Config"), key, Buffer.of(255)]);
  const ours = fakeConnection({ account: config(authority.publicKey.toBytes()) });
  assert.equal(await new SolanaChain(settings, ours.connection).ensureInitialized(), "exists");
  assert.equal(ours.sent.length, 0);

  const theirs = fakeConnection({ account: config(Keypair.generate().publicKey.toBytes()) });
  await assert.rejects(new SolanaChain(settings, theirs.connection).ensureInitialized(), /not this server's key/);
});
