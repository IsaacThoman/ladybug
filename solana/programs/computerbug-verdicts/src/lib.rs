use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod state;

use error::VerdictError;
use events::{ReportSubmitted, ScanRecorded};
use state::*;

declare_id!("AS1X4exfmHfHQ35cgJMAuHjubYNnmie2JuCGtLSj6jn");

#[program]
pub mod computerbug_verdicts {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }

    pub fn record_scan(
        ctx: Context<RecordScan>,
        host_hash: [u8; 32],
        host: String,
        verdict: u8,
        score: u8,
        report_hash: [u8; 32],
    ) -> Result<()> {
        check_host(&host_hash, &host)?;
        require!(
            (SCAN_BENIGN..=SCAN_MALICIOUS).contains(&verdict),
            VerdictError::InvalidVerdict
        );
        require!(score <= MAX_SCORE, VerdictError::InvalidScore);

        let site = &mut ctx.accounts.site;
        site.host_hash = host_hash;
        site.host = host;
        site.bump = ctx.bumps.site;
        site.scan_verdict = verdict;
        site.scan_score = score;
        site.scan_report_hash = report_hash;
        site.scanned_at = Clock::get()?.unix_timestamp;

        emit!(ScanRecorded {
            site: site.key(),
            host: site.host.clone(),
            verdict,
            score,
            report_hash,
        });
        Ok(())
    }

    pub fn submit_report(
        ctx: Context<SubmitReport>,
        host_hash: [u8; 32],
        host: String,
        verdict: u8,
        url_hash: [u8; 32],
    ) -> Result<()> {
        check_host(&host_hash, &host)?;
        require!(
            verdict == VOTE_SAFE || verdict == VOTE_UNSAFE,
            VerdictError::InvalidVerdict
        );

        let site = &mut ctx.accounts.site;
        site.host_hash = host_hash;
        site.host = host;
        site.bump = ctx.bumps.site;

        let report = &mut ctx.accounts.report;
        let previous = report.verdict;
        if previous != verdict {
            match previous {
                VOTE_SAFE => site.safe_reports = site.safe_reports.saturating_sub(1),
                VOTE_UNSAFE => site.unsafe_reports = site.unsafe_reports.saturating_sub(1),
                _ => {}
            }
            match verdict {
                VOTE_SAFE => site.safe_reports = site.safe_reports.saturating_add(1),
                _ => site.unsafe_reports = site.unsafe_reports.saturating_add(1),
            }
        }

        report.site = site.key();
        report.reporter = ctx.accounts.reporter.key();
        report.verdict = verdict;
        report.url_hash = url_hash;
        report.reported_at = Clock::get()?.unix_timestamp;
        report.bump = ctx.bumps.report;

        emit!(ReportSubmitted {
            site: site.key(),
            reporter: report.reporter,
            verdict,
            safe_reports: site.safe_reports,
            unsafe_reports: site.unsafe_reports,
        });
        Ok(())
    }
}

fn check_host(host_hash: &[u8; 32], host: &str) -> Result<()> {
    require!(host.len() <= MAX_HOST_LEN, VerdictError::HostTooLong);
    require!(
        solana_sha256_hasher::hash(host.as_bytes()).to_bytes() == *host_hash,
        VerdictError::HostHashMismatch
    );
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ VerdictError::Unauthorized
    )]
    pub program: Program<'info, program::ComputerbugVerdicts>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(payer.key())
            @ VerdictError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ VerdictError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(host_hash: [u8; 32])]
pub struct RecordScan<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ VerdictError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Site::INIT_SPACE,
        seeds = [SITE_SEED, host_hash.as_ref()],
        bump
    )]
    pub site: Account<'info, Site>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(host_hash: [u8; 32])]
pub struct SubmitReport<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ VerdictError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Site::INIT_SPACE,
        seeds = [SITE_SEED, host_hash.as_ref()],
        bump
    )]
    pub site: Account<'info, Site>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Report::INIT_SPACE,
        seeds = [REPORT_SEED, site.key().as_ref(), reporter.key().as_ref()],
        bump
    )]
    pub report: Account<'info, Report>,
    pub reporter: Signer<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
