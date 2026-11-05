# ATS docs PR notes (F28)

Candidate fixes for a docs PR to [hashgraph/asset-tokenization-studio](https://github.com/hashgraph/asset-tokenization-studio). Not submitted yet.

## Stale testnet addresses in the SDK README

**File:** `packages/ats/sdk/README.md`, section "Initialise the SDK". Checked on 5 Nov 2026 at tag `v.8.0.0-ats` and on `main` at commit `6bf1d26`.

| Line | Contract | README says | Current value |
| --- | --- | --- | --- |
| 1372 | Factory | `0.0.6797955` | `0.0.9213391` |
| 1369 | Resolver | `0.0.6797832` | `0.0.9212226` |

**Source of the current values:** `apps/ats/web/.env.example` (`REACT_APP_RPC_FACTORY`, `REACT_APP_RPC_RESOLVER`). The old contracts still exist on testnet, but date from September 2025.

Before submitting, check that these lines and values are still current on `main`.

## Also worth fixing in the same section

Line 1392 says "only metamask is compatible right now", but `SupportedWallets` also includes `HWALLETCONNECT`, `DFNS`, `FIREBLOCKS` and `AWSKMS`.
