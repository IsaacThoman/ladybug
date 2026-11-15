# Computerbug verdicts program

Anchor program that stores community reports and sandbox scan verdicts per host. Accounts, instructions and the server setup are in [../docs/solana.md](../docs/solana.md).

Program id: `AS1X4exfmHfHQ35cgJMAuHjubYNnmie2JuCGtLSj6jn`

This is a plain Cargo/Anchor workspace, separate from the npm workspaces. Tests are Rust (LiteSVM), so there is no JS harness here.

## Toolchain

- Rust via [rustup](https://rustup.rs) (`rust-toolchain.toml` pins the host toolchain)
- Solana CLI (Agave) 4.1.2: `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`
- Anchor 1.2.2 via avm: `cargo install --git https://github.com/otter-sec/anchor --tag v1.2.2 avm --force && avm install 1.2.2 && avm use 1.2.2`

## Build and test

```sh
cd solana
anchor build    # target/deploy/computerbug_verdicts.so and target/idl/computerbug_verdicts.json
cargo test      # loads the built .so into LiteSVM, so build first
```

The tests encode instructions and decode accounts by hand from the spec, the same way the server does, so a layout change that isn't mirrored in `docs/solana.md` fails them.

## Keys

Keypairs live outside the repo, in `~/.config/computerbug-solana/`:

- `program-keypair.json`: the program id
- `authority.json`: the server key. It is the program's upgrade authority, which is what lets the server call `initialize` itself, and `SOLANA_AUTHORITY_KEY` is this file's contents

`anchor build` warns when `target/deploy/computerbug_verdicts-keypair.json` doesn't match `declare_id!`. Point it at the real key instead of running `anchor keys sync`, which would replace the program id:

```sh
ln -sf ~/.config/computerbug-solana/program-keypair.json target/deploy/computerbug_verdicts-keypair.json
```

## Deploy (devnet)

The authority needs about 2.6 SOL while deploying (the upload buffer and the program account at the same time; the buffer is refunded afterwards, leaving the program's ~1.24 SOL rent), plus a little for fees. The devnet RPC faucet is closed, so fund it from <https://faucet.solana.com>:

```sh
solana address -k ~/.config/computerbug-solana/authority.json
solana balance -u devnet ~/.config/computerbug-solana/authority.json
```

Then:

```sh
anchor build
solana program deploy target/deploy/computerbug_verdicts.so \
  --url devnet \
  --program-id ~/.config/computerbug-solana/program-keypair.json \
  --keypair ~/.config/computerbug-solana/authority.json \
  --upgrade-authority ~/.config/computerbug-solana/authority.json
```

Run the same command again to upgrade. Never deploy with a different upgrade authority: `initialize` only accepts the upgrade authority, so nobody can front-run it after a deploy.

## Server configuration

```sh
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_CLUSTER=devnet
SOLANA_PROGRAM_ID=AS1X4exfmHfHQ35cgJMAuHjubYNnmie2JuCGtLSj6jn
SOLANA_AUTHORITY_KEY="$(cat ~/.config/computerbug-solana/authority.json)"
SOLANA_REPORTER_SECRET="$(openssl rand -hex 32)"
```

On startup the server creates `Config` (calls `initialize` with its own key as the authority) when it doesn't exist yet. Keep the authority funded: it pays for every site and report account and every transaction.
