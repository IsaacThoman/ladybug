use anchor_lang::prelude::*;

#[event]
pub struct ScanRecorded {
    pub site: Pubkey,
    pub host: String,
    pub verdict: u8,
    pub score: u8,
    pub report_hash: [u8; 32],
}

#[event]
pub struct ReportSubmitted {
    pub site: Pubkey,
    pub reporter: Pubkey,
    pub verdict: u8,
    pub safe_reports: u32,
    pub unsafe_reports: u32,
}
