# Community reports on Solana

Signed-in people can report a site as safe or unsafe: from the extension popup, from the page the extension blocks ("I think this site is safe"), and from a scan's report page. Each account has one vote per host and can change it. The server keeps the votes in Postgres (`site_reports`), and, when Solana is configured, also writes every vote and every sandbox verdict to the Computerbug program on-chain, so anyone can check the tallies without trusting the server's database.

Reports never flip a verdict on their own. They show as a tally next to the verdict, mark the host for review in the admin URL database when they disagree with it, and three or more "unsafe" reports from different accounts count as one signal in the scan score (`COMMUNITY_SIGNAL_MIN_REPORTS`).

## Why the server co-signs

Wallets are free, so open on-chain voting is easy to brigade: a scammer can vote their own page safe from a thousand keys. The program only accepts a report signed by the configured `authority` (the server), and the server only signs for approved accounts. Each account gets its own reporter key, derived on the server as `ed25519 seed = HMAC-SHA256(SOLANA_REPORTER_SECRET, "reporter:" + accountId)`, so one approved account is one reporter is one vote per site, on-chain as well as in Postgres. The server pays all fees, so nobody needs SOL.

## Program

Anchor program `computerbug_verdicts`, in [`solana/`](../solana). Program id: see `declare_id!` in `solana/programs/computerbug-verdicts/src/lib.rs` (also `SOLANA_PROGRAM_ID`).

All integers are little-endian (Borsh). `host_hash` is SHA-256 of the normalised host (lowercase, no trailing dot) as UTF-8; the program checks it against `host`. Hosts are at most 253 bytes.

### Accounts

| Account | Seeds | Fields (after the 8-byte Anchor discriminator) |
|---|---|---|
| `Config` | `["config"]` | `authority: Pubkey`, `bump: u8` |
| `Site` | `["site", host_hash]` | `host_hash: [u8; 32]`, `host: String` (u32 length + bytes), `safe_reports: u32`, `unsafe_reports: u32`, `scan_verdict: u8` (0 none, 1 benign, 2 suspicious, 3 malicious), `scan_score: u8`, `scan_report_hash: [u8; 32]`, `scanned_at: i64` (unix seconds, 0 = never), `bump: u8` |
| `Report` | `["report", site, reporter]` | `site: Pubkey`, `reporter: Pubkey`, `verdict: u8` (1 safe, 2 unsafe), `url_hash: [u8; 32]`, `reported_at: i64`, `bump: u8` |

`Site` is allocated for the longest host (8 + 32 + 4 + 253 + 4 + 4 + 1 + 1 + 32 + 8 + 1 bytes), so it never needs a realloc.

### Instructions

Discriminators are the first 8 bytes of `sha256("global:<name>")`, as usual for Anchor.

| Instruction | Args | Accounts | Does |
|---|---|---|---|
| `initialize` | `authority: Pubkey` | `config` (init, PDA), `payer` (signer, mut), `program` (this program), `program_data` (its BPF upgradeable loader ProgramData account, PDA of the loader with seed `[program_id]`), `system_program` | Creates `Config`. Once, and only the program's upgrade authority may call it, so nobody can front-run it after a deploy. The server calls it on startup when `Config` is missing and its key is the upgrade authority. |
| `set_authority` | `new_authority: Pubkey` | `config` (mut), `authority` (signer) | Rotates the server key. |
| `record_scan` | `host_hash: [u8; 32]`, `host: String`, `verdict: u8` (1–3), `score: u8` (0–100), `report_hash: [u8; 32]` | `config`, `site` (init_if_needed, PDA), `authority` (signer, mut, pays), `system_program` | Stores the latest scan verdict for the host. |
| `submit_report` | `host_hash: [u8; 32]`, `host: String`, `verdict: u8` (1–2), `url_hash: [u8; 32]` | `config`, `site` (init_if_needed, PDA), `report` (init_if_needed, PDA), `reporter` (signer), `authority` (signer, mut, pays), `system_program` | Creates or changes the reporter's vote on the host and keeps the tallies right. Voting the same way again only updates `url_hash` and `reported_at`. |

Errors, as Anchor custom error codes 6000–6004 in this order: `Unauthorized` (signer isn't `config.authority`, or `initialize` payer isn't the upgrade authority), `HostHashMismatch`, `HostTooLong`, `InvalidVerdict`, `InvalidScore`.

Events: `ScanRecorded { site, host, verdict, score, report_hash }` and `ReportSubmitted { site, reporter, verdict, safe_reports, unsafe_reports }`.

Only explicit reports go on-chain, never the visits the extension reports. Full URLs are hashed (`url_hash` is SHA-256 of the normalised URL): they can carry tokens and email addresses. Hosts are stored in clear so the tallies are readable.

## Server configuration

Leave these unset and reports still work, in Postgres only (`chain: null` in responses).

| Var | Secret | Meaning |
|---|---|---|
| `SOLANA_RPC_URL` | | e.g. `https://api.devnet.solana.com` |
| `SOLANA_CLUSTER` | | `devnet` (default), `testnet`, `mainnet-beta` or `localnet`, for Explorer links |
| `SOLANA_PROGRAM_ID` | | the deployed program's id |
| `SOLANA_AUTHORITY_KEY` | yes | the server's keypair: a JSON byte array (as `solana-keygen` writes it) or base58. It pays fees, so keep it funded |
| `SOLANA_REPORTER_SECRET` | yes | random string reporter keys are derived from. Changing it gives every account a new reporter key, and so a second vote |
