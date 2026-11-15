use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const SITE_SEED: &[u8] = b"site";
pub const REPORT_SEED: &[u8] = b"report";

pub const MAX_HOST_LEN: usize = 253;

pub const SCAN_BENIGN: u8 = 1;
pub const SCAN_MALICIOUS: u8 = 3;
pub const MAX_SCORE: u8 = 100;

pub const VOTE_SAFE: u8 = 1;
pub const VOTE_UNSAFE: u8 = 2;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Site {
    pub host_hash: [u8; 32],
    #[max_len(MAX_HOST_LEN)]
    pub host: String,
    pub safe_reports: u32,
    pub unsafe_reports: u32,
    pub scan_verdict: u8,
    pub scan_score: u8,
    pub scan_report_hash: [u8; 32],
    pub scanned_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Report {
    pub site: Pubkey,
    pub reporter: Pubkey,
    pub verdict: u8,
    pub url_hash: [u8; 32],
    pub reported_at: i64,
    pub bump: u8,
}
