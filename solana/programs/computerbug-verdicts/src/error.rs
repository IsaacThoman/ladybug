use anchor_lang::prelude::*;

#[error_code]
pub enum VerdictError {
    #[msg("Signer is not the configured authority")]
    Unauthorized,
    #[msg("host_hash is not the SHA-256 of host")]
    HostHashMismatch,
    #[msg("Host is longer than 253 bytes")]
    HostTooLong,
    #[msg("Verdict is out of range")]
    InvalidVerdict,
    #[msg("Score must be 0-100")]
    InvalidScore,
}
