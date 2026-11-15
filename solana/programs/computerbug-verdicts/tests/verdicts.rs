//! Runs the built program (`anchor build` first) in LiteSVM. Instructions are
//! encoded and accounts decoded by hand from docs/solana.md, the same way the
//! server's TypeScript client does, so a layout drift fails here.

#![allow(clippy::result_large_err)]

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            bpf_loader_upgradeable,
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        InstructionData, ToAccountMetas,
    },
    computerbug_verdicts as verdicts,
    litesvm::{types::TransactionResult, LiteSVM},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    solana_transaction_error::TransactionError,
};

const PROGRAM_SO: &[u8] = include_bytes!(concat!(
    env!("CARGO_TARGET_TMPDIR"),
    "/../deploy/computerbug_verdicts.so"
));
const SOL: u64 = 1_000_000_000;
const NOW: i64 = 1_763_000_000;
const SITE_SPACE: usize = 8 + 32 + 4 + 253 + 4 + 4 + 1 + 1 + 32 + 8 + 1;
const REPORT_SPACE: usize = 8 + 32 + 32 + 1 + 32 + 8 + 1;
const CONFIG_SPACE: usize = 8 + 32 + 1;

const UNAUTHORIZED: u32 = 6000;
const HOST_HASH_MISMATCH: u32 = 6001;
const HOST_TOO_LONG: u32 = 6002;
const INVALID_VERDICT: u32 = 6003;
const INVALID_SCORE: u32 = 6004;
const ACCOUNT_NOT_SIGNER: u32 = 3010;

const SAFE: u8 = 1;
const UNSAFE: u8 = 2;
const MALICIOUS: u8 = 3;

// ---------- environment ----------

struct Env {
    svm: LiteSVM,
    /// Upgrade authority and, after `initialize`, config authority.
    authority: Keypair,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(verdicts::ID, PROGRAM_SO).unwrap();
        let authority = Keypair::new();
        svm.airdrop(&authority.pubkey(), 10 * SOL).unwrap();
        set_upgrade_authority(&mut svm, &verdicts::ID, Some(authority.pubkey()));
        let mut env = Env { svm, authority };
        env.set_time(NOW);
        env
    }

    fn initialized() -> Self {
        let mut env = Env::new();
        let authority = env.authority.pubkey();
        let ix = initialize_ix(authority, authority, program_data_address(&verdicts::ID));
        env.send(&[ix], &[&env.authority.insecure_clone()]).unwrap();
        env
    }

    fn funded(&mut self) -> Keypair {
        let keypair = Keypair::new();
        self.svm.airdrop(&keypair.pubkey(), SOL).unwrap();
        keypair
    }

    fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// The first signer pays the fee.
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let message = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap();
        self.svm.send_transaction(tx)
    }

    fn scan(
        &mut self,
        host: &str,
        verdict: u8,
        score: u8,
        report_hash: [u8; 32],
    ) -> TransactionResult {
        let authority = self.authority.insecure_clone();
        let ix = record_scan_ix(
            authority.pubkey(),
            sha256(host),
            host,
            verdict,
            score,
            report_hash,
        );
        self.send(&[ix], &[&authority])
    }

    fn report(
        &mut self,
        reporter: &Keypair,
        host: &str,
        verdict: u8,
        url_hash: [u8; 32],
    ) -> TransactionResult {
        let authority = self.authority.insecure_clone();
        let ix = submit_report_ix(
            authority.pubkey(),
            reporter.pubkey(),
            sha256(host),
            host,
            verdict,
            url_hash,
        );
        self.send(&[ix], &[&authority, reporter])
    }

    fn site(&self, host: &str) -> SiteView {
        let data = self
            .svm
            .get_account(&site_address(&sha256(host)))
            .unwrap()
            .data;
        SiteView::decode(&data)
    }

    fn report_account(&self, host: &str, reporter: &Pubkey) -> ReportView {
        let site = site_address(&sha256(host));
        let data = self
            .svm
            .get_account(&report_address(&site, reporter))
            .unwrap()
            .data;
        ReportView::decode(&data)
    }
}

/// Rewrites the ProgramData header: u32 tag (3), u64 slot, Option<Pubkey>.
fn set_upgrade_authority(svm: &mut LiteSVM, program_id: &Pubkey, authority: Option<Pubkey>) {
    let address = program_data_address(program_id);
    let mut account = svm.get_account(&address).unwrap();
    assert_eq!(&account.data[0..4], &3u32.to_le_bytes());
    match authority {
        Some(key) => {
            account.data[12] = 1;
            account.data[13..45].copy_from_slice(key.as_ref());
        }
        None => account.data[12..45].fill(0),
    }
    svm.set_account(address, account).unwrap();
}

fn custom_error(result: &TransactionResult) -> Option<u32> {
    match result {
        Err(failed) => match failed.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(code),
            _ => None,
        },
        Ok(_) => None,
    }
}

fn assert_error(result: TransactionResult, code: u32) {
    assert_eq!(custom_error(&result), Some(code), "{result:#?}");
}

// ---------- spec encoding ----------

fn sha256(data: impl AsRef<[u8]>) -> [u8; 32] {
    solana_sha256_hasher::hash(data.as_ref()).to_bytes()
}

fn discriminator(namespace: &str, name: &str) -> [u8; 8] {
    sha256(format!("{namespace}:{name}"))[..8]
        .try_into()
        .unwrap()
}

fn borsh_string(value: &str) -> Vec<u8> {
    let mut out = (value.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(value.as_bytes());
    out
}

fn ix_data(name: &str, args: &[&[u8]]) -> Vec<u8> {
    let mut data = discriminator("global", name).to_vec();
    for arg in args {
        data.extend_from_slice(arg);
    }
    data
}

fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &verdicts::ID).0
}

fn site_address(host_hash: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"site", host_hash], &verdicts::ID).0
}

fn report_address(site: &Pubkey, reporter: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"report", site.as_ref(), reporter.as_ref()],
        &verdicts::ID,
    )
    .0
}

fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

fn initialize_ix(payer: Pubkey, authority: Pubkey, program_data: Pubkey) -> Instruction {
    Instruction {
        program_id: verdicts::ID,
        accounts: vec![
            AccountMeta::new(config_address(), false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(verdicts::ID, false),
            AccountMeta::new_readonly(program_data, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: ix_data("initialize", &[authority.as_ref()]),
    }
}

fn set_authority_ix(authority: Pubkey, new_authority: Pubkey) -> Instruction {
    Instruction {
        program_id: verdicts::ID,
        accounts: vec![
            AccountMeta::new(config_address(), false),
            AccountMeta::new_readonly(authority, true),
        ],
        data: ix_data("set_authority", &[new_authority.as_ref()]),
    }
}

fn record_scan_ix(
    authority: Pubkey,
    host_hash: [u8; 32],
    host: &str,
    verdict: u8,
    score: u8,
    report_hash: [u8; 32],
) -> Instruction {
    Instruction {
        program_id: verdicts::ID,
        accounts: vec![
            AccountMeta::new_readonly(config_address(), false),
            AccountMeta::new(site_address(&host_hash), false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: ix_data(
            "record_scan",
            &[
                &host_hash,
                &borsh_string(host),
                &[verdict],
                &[score],
                &report_hash,
            ],
        ),
    }
}

fn submit_report_ix(
    authority: Pubkey,
    reporter: Pubkey,
    host_hash: [u8; 32],
    host: &str,
    verdict: u8,
    url_hash: [u8; 32],
) -> Instruction {
    let site = site_address(&host_hash);
    Instruction {
        program_id: verdicts::ID,
        accounts: vec![
            AccountMeta::new_readonly(config_address(), false),
            AccountMeta::new(site, false),
            AccountMeta::new(report_address(&site, &reporter), false),
            AccountMeta::new_readonly(reporter, true),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: ix_data(
            "submit_report",
            &[&host_hash, &borsh_string(host), &[verdict], &url_hash],
        ),
    }
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8], account: &str) -> Self {
        assert_eq!(
            data[..8],
            discriminator("account", account),
            "{account} discriminator"
        );
        Reader { data, pos: 8 }
    }
    fn take(&mut self, len: usize) -> &'a [u8] {
        let out = &self.data[self.pos..self.pos + len];
        self.pos += len;
        out
    }
    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn i64(&mut self) -> i64 {
        i64::from_le_bytes(self.take(8).try_into().unwrap())
    }
    fn bytes32(&mut self) -> [u8; 32] {
        self.take(32).try_into().unwrap()
    }
    fn pubkey(&mut self) -> Pubkey {
        Pubkey::new_from_array(self.bytes32())
    }
    fn string(&mut self) -> String {
        let len = self.u32() as usize;
        String::from_utf8(self.take(len).to_vec()).unwrap()
    }
}

#[derive(Debug)]
struct ConfigView {
    authority: Pubkey,
    bump: u8,
}

#[derive(Debug)]
struct SiteView {
    host_hash: [u8; 32],
    host: String,
    safe_reports: u32,
    unsafe_reports: u32,
    scan_verdict: u8,
    scan_score: u8,
    scan_report_hash: [u8; 32],
    scanned_at: i64,
    bump: u8,
}

#[derive(Debug)]
struct ReportView {
    site: Pubkey,
    reporter: Pubkey,
    verdict: u8,
    url_hash: [u8; 32],
    reported_at: i64,
    bump: u8,
}

impl ConfigView {
    fn decode(data: &[u8]) -> Self {
        assert_eq!(data.len(), CONFIG_SPACE);
        let mut r = Reader::new(data, "Config");
        ConfigView {
            authority: r.pubkey(),
            bump: r.u8(),
        }
    }
}

impl SiteView {
    fn decode(data: &[u8]) -> Self {
        assert_eq!(data.len(), SITE_SPACE);
        let mut r = Reader::new(data, "Site");
        SiteView {
            host_hash: r.bytes32(),
            host: r.string(),
            safe_reports: r.u32(),
            unsafe_reports: r.u32(),
            scan_verdict: r.u8(),
            scan_score: r.u8(),
            scan_report_hash: r.bytes32(),
            scanned_at: r.i64(),
            bump: r.u8(),
        }
    }
}

impl ReportView {
    fn decode(data: &[u8]) -> Self {
        assert_eq!(data.len(), REPORT_SPACE);
        let mut r = Reader::new(data, "Report");
        ReportView {
            site: r.pubkey(),
            reporter: r.pubkey(),
            verdict: r.u8(),
            url_hash: r.bytes32(),
            reported_at: r.i64(),
            bump: r.u8(),
        }
    }
}

// ---------- initialize / set_authority ----------

#[test]
fn initialize_by_upgrade_authority() {
    let mut env = Env::new();
    let payer = env.authority.insecure_clone();
    let server = Keypair::new().pubkey();
    let ix = initialize_ix(payer.pubkey(), server, program_data_address(&verdicts::ID));
    env.send(std::slice::from_ref(&ix), &[&payer]).unwrap();

    let config = ConfigView::decode(&env.svm.get_account(&config_address()).unwrap().data);
    assert_eq!(config.authority, server);
    let (_, bump) = Pubkey::find_program_address(&[b"config"], &verdicts::ID);
    assert_eq!(config.bump, bump);

    assert!(env.send(&[ix], &[&payer]).is_err(), "initialize runs once");
}

#[test]
fn initialize_rejects_non_upgrade_authority() {
    let mut env = Env::new();
    let attacker = env.funded();
    let ix = initialize_ix(
        attacker.pubkey(),
        attacker.pubkey(),
        program_data_address(&verdicts::ID),
    );
    assert_error(env.send(&[ix], &[&attacker]), UNAUTHORIZED);
    assert!(env.svm.get_account(&config_address()).is_none());
}

#[test]
fn initialize_rejects_immutable_program() {
    let mut env = Env::new();
    set_upgrade_authority(&mut env.svm, &verdicts::ID, None);
    let payer = env.authority.insecure_clone();
    let ix = initialize_ix(
        payer.pubkey(),
        payer.pubkey(),
        program_data_address(&verdicts::ID),
    );
    assert_error(env.send(&[ix], &[&payer]), UNAUTHORIZED);
}

#[test]
fn initialize_rejects_another_programs_program_data() {
    let mut env = Env::new();
    let attacker = env.funded();
    let decoy = Keypair::new().pubkey();
    env.svm.add_program(decoy, PROGRAM_SO).unwrap();
    set_upgrade_authority(&mut env.svm, &decoy, Some(attacker.pubkey()));

    let ix = initialize_ix(
        attacker.pubkey(),
        attacker.pubkey(),
        program_data_address(&decoy),
    );
    assert_error(env.send(&[ix], &[&attacker]), UNAUTHORIZED);
}

#[test]
fn set_authority_rotates_the_server_key() {
    let mut env = Env::initialized();
    let old = env.authority.insecure_clone();
    let new = env.funded();

    let stranger = env.funded();
    assert_error(
        env.send(
            &[set_authority_ix(stranger.pubkey(), stranger.pubkey())],
            &[&stranger],
        ),
        UNAUTHORIZED,
    );

    env.send(&[set_authority_ix(old.pubkey(), new.pubkey())], &[&old])
        .unwrap();
    let config = ConfigView::decode(&env.svm.get_account(&config_address()).unwrap().data);
    assert_eq!(config.authority, new.pubkey());

    assert_error(
        env.scan("example.com", MALICIOUS, 90, [1; 32]),
        UNAUTHORIZED,
    );
    env.authority = new;
    env.scan("example.com", MALICIOUS, 90, [1; 32]).unwrap();
}

// ---------- record_scan ----------

#[test]
fn record_scan_requires_the_authority() {
    let mut env = Env::initialized();
    let stranger = env.funded();
    let ix = record_scan_ix(
        stranger.pubkey(),
        sha256("example.com"),
        "example.com",
        MALICIOUS,
        90,
        [1; 32],
    );
    assert_error(env.send(&[ix], &[&stranger]), UNAUTHORIZED);
}

#[test]
fn record_scan_creates_then_overwrites() {
    let mut env = Env::initialized();
    env.scan("phish.example", MALICIOUS, 92, [7; 32]).unwrap();

    let site = env.site("phish.example");
    assert_eq!(site.host_hash, sha256("phish.example"));
    assert_eq!(site.host, "phish.example");
    assert_eq!((site.safe_reports, site.unsafe_reports), (0, 0));
    assert_eq!((site.scan_verdict, site.scan_score), (MALICIOUS, 92));
    assert_eq!(site.scan_report_hash, [7; 32]);
    assert_eq!(site.scanned_at, NOW);
    assert_eq!(
        site.bump,
        Pubkey::find_program_address(&[b"site", &sha256("phish.example")], &verdicts::ID).1
    );

    env.set_time(NOW + 60);
    env.scan("phish.example", 1, 4, [8; 32]).unwrap();
    let site = env.site("phish.example");
    assert_eq!((site.scan_verdict, site.scan_score), (1, 4));
    assert_eq!(site.scan_report_hash, [8; 32]);
    assert_eq!(site.scanned_at, NOW + 60);
}

#[test]
fn record_scan_validates_args() {
    let mut env = Env::initialized();
    assert_error(env.scan("a.example", 0, 50, [0; 32]), INVALID_VERDICT);
    assert_error(env.scan("a.example", 4, 50, [0; 32]), INVALID_VERDICT);
    assert_error(
        env.scan("a.example", MALICIOUS, 101, [0; 32]),
        INVALID_SCORE,
    );
    env.scan("a.example", MALICIOUS, 100, [0; 32]).unwrap();

    let authority = env.authority.insecure_clone();
    let ix = record_scan_ix(
        authority.pubkey(),
        sha256("real.example"),
        "fake.example",
        MALICIOUS,
        50,
        [0; 32],
    );
    assert_error(env.send(&[ix], &[&authority]), HOST_HASH_MISMATCH);

    let too_long = format!("{}.example", "a".repeat(246));
    assert_eq!(too_long.len(), 254);
    assert_error(env.scan(&too_long, MALICIOUS, 50, [0; 32]), HOST_TOO_LONG);

    let longest = format!("{}.example", "a".repeat(245));
    assert_eq!(longest.len(), 253);
    env.scan(&longest, MALICIOUS, 50, [0; 32]).unwrap();
    assert_eq!(env.site(&longest).host, longest);
}

// ---------- submit_report ----------

#[test]
fn submit_report_new_vote() {
    let mut env = Env::initialized();
    let reporter = Keypair::new();
    env.report(&reporter, "shop.example", UNSAFE, [3; 32])
        .unwrap();

    let site = env.site("shop.example");
    assert_eq!(site.host, "shop.example");
    assert_eq!((site.safe_reports, site.unsafe_reports), (0, 1));
    assert_eq!((site.scan_verdict, site.scanned_at), (0, 0));

    let report = env.report_account("shop.example", &reporter.pubkey());
    assert_eq!(report.site, site_address(&sha256("shop.example")));
    assert_eq!(report.reporter, reporter.pubkey());
    assert_eq!(report.verdict, UNSAFE);
    assert_eq!(report.url_hash, [3; 32]);
    assert_eq!(report.reported_at, NOW);
    let (_, bump) = Pubkey::find_program_address(
        &[b"report", report.site.as_ref(), reporter.pubkey().as_ref()],
        &verdicts::ID,
    );
    assert_eq!(report.bump, bump);
}

#[test]
fn submit_report_changed_vote_moves_tallies() {
    let mut env = Env::initialized();
    let alice = Keypair::new();
    let bob = Keypair::new();
    env.report(&alice, "shop.example", UNSAFE, [1; 32]).unwrap();
    env.report(&bob, "shop.example", UNSAFE, [1; 32]).unwrap();
    assert_eq!(env.site("shop.example").unsafe_reports, 2);

    env.set_time(NOW + 10);
    env.report(&alice, "shop.example", SAFE, [2; 32]).unwrap();
    let site = env.site("shop.example");
    assert_eq!((site.safe_reports, site.unsafe_reports), (1, 1));
    let report = env.report_account("shop.example", &alice.pubkey());
    assert_eq!(
        (report.verdict, report.url_hash, report.reported_at),
        (SAFE, [2; 32], NOW + 10)
    );

    env.report(&alice, "shop.example", UNSAFE, [2; 32]).unwrap();
    let site = env.site("shop.example");
    assert_eq!((site.safe_reports, site.unsafe_reports), (0, 2));
}

#[test]
fn submit_report_same_vote_only_touches_url_and_time() {
    let mut env = Env::initialized();
    let reporter = Keypair::new();
    env.report(&reporter, "shop.example", SAFE, [1; 32])
        .unwrap();

    env.set_time(NOW + 99);
    env.report(&reporter, "shop.example", SAFE, [9; 32])
        .unwrap();
    let site = env.site("shop.example");
    assert_eq!((site.safe_reports, site.unsafe_reports), (1, 0));
    let report = env.report_account("shop.example", &reporter.pubkey());
    assert_eq!(
        (report.verdict, report.url_hash, report.reported_at),
        (SAFE, [9; 32], NOW + 99)
    );
}

#[test]
fn submit_report_requires_both_signatures() {
    let mut env = Env::initialized();
    let authority = env.authority.insecure_clone();
    let reporter = env.funded();
    let ix = submit_report_ix(
        authority.pubkey(),
        reporter.pubkey(),
        sha256("x.example"),
        "x.example",
        UNSAFE,
        [0; 32],
    );

    let mut no_authority = ix.clone();
    no_authority.accounts[4].is_signer = false;
    assert_error(env.send(&[no_authority], &[&reporter]), ACCOUNT_NOT_SIGNER);

    let mut no_reporter = ix.clone();
    no_reporter.accounts[3].is_signer = false;
    assert_error(env.send(&[no_reporter], &[&authority]), ACCOUNT_NOT_SIGNER);

    let stranger = env.funded();
    let forged = submit_report_ix(
        stranger.pubkey(),
        reporter.pubkey(),
        sha256("x.example"),
        "x.example",
        UNSAFE,
        [0; 32],
    );
    assert_error(env.send(&[forged], &[&stranger, &reporter]), UNAUTHORIZED);

    assert!(env
        .svm
        .get_account(&site_address(&sha256("x.example")))
        .is_none());
    env.send(&[ix], &[&authority, &reporter]).unwrap();
}

#[test]
fn submit_report_validates_args() {
    let mut env = Env::initialized();
    let reporter = Keypair::new();
    assert_error(
        env.report(&reporter, "x.example", 0, [0; 32]),
        INVALID_VERDICT,
    );
    assert_error(
        env.report(&reporter, "x.example", 3, [0; 32]),
        INVALID_VERDICT,
    );

    let authority = env.authority.insecure_clone();
    let ix = submit_report_ix(
        authority.pubkey(),
        reporter.pubkey(),
        sha256("x.example"),
        "X.example",
        SAFE,
        [0; 32],
    );
    assert_error(
        env.send(&[ix], &[&authority, &reporter]),
        HOST_HASH_MISMATCH,
    );
}

#[test]
fn scans_and_reports_share_the_site() {
    let mut env = Env::initialized();
    let reporter = Keypair::new();
    env.scan("both.example", MALICIOUS, 80, [5; 32]).unwrap();
    env.report(&reporter, "both.example", SAFE, [6; 32])
        .unwrap();
    env.scan("both.example", 2, 40, [7; 32]).unwrap();

    let site = env.site("both.example");
    assert_eq!((site.safe_reports, site.unsafe_reports), (1, 0));
    assert_eq!(
        (site.scan_verdict, site.scan_score, site.scan_report_hash),
        (2, 40, [7; 32])
    );
}

// ---------- the spec matches what Anchor generates ----------

#[test]
fn hand_encoding_matches_anchor() {
    let authority = Keypair::new().pubkey();
    let reporter = Keypair::new().pubkey();
    let host = "example.com";
    let host_hash = sha256(host);
    let site = site_address(&host_hash);
    let program_data = program_data_address(&verdicts::ID);

    let ours = initialize_ix(authority, reporter, program_data);
    assert_eq!(
        ours.data,
        verdicts::instruction::Initialize {
            authority: reporter
        }
        .data()
    );
    assert_eq!(
        ours.accounts,
        verdicts::accounts::Initialize {
            config: config_address(),
            payer: authority,
            program: verdicts::ID,
            program_data,
            system_program: system_program::ID,
        }
        .to_account_metas(None)
    );

    let ours = set_authority_ix(authority, reporter);
    assert_eq!(
        ours.data,
        verdicts::instruction::SetAuthority {
            new_authority: reporter
        }
        .data()
    );
    assert_eq!(
        ours.accounts,
        verdicts::accounts::SetAuthority {
            config: config_address(),
            authority
        }
        .to_account_metas(None)
    );

    let ours = record_scan_ix(authority, host_hash, host, 3, 77, [4; 32]);
    let anchor = verdicts::instruction::RecordScan {
        host_hash,
        host: host.to_string(),
        verdict: 3,
        score: 77,
        report_hash: [4; 32],
    };
    assert_eq!(ours.data, anchor.data());
    assert_eq!(
        ours.accounts,
        verdicts::accounts::RecordScan {
            config: config_address(),
            site,
            authority,
            system_program: system_program::ID,
        }
        .to_account_metas(None)
    );

    let ours = submit_report_ix(authority, reporter, host_hash, host, 2, [5; 32]);
    let anchor = verdicts::instruction::SubmitReport {
        host_hash,
        host: host.to_string(),
        verdict: 2,
        url_hash: [5; 32],
    };
    assert_eq!(ours.data, anchor.data());
    assert_eq!(
        ours.accounts,
        verdicts::accounts::SubmitReport {
            config: config_address(),
            site,
            report: report_address(&site, &reporter),
            reporter,
            authority,
            system_program: system_program::ID,
        }
        .to_account_metas(None)
    );
}
