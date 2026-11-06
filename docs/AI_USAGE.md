# AI usage

Udhaar was built solo with AI coding tools. This page says which tool did what, how the work was split, the rules I set, and how the output was checked.

## Who did what

| Tool | Used for |
| --- | --- |
| **Claude Code** | The backend in `backend/`: ATS bond calls, the uINR token, HCS topics, repayment, the risk engine, the trust layer, the x402 paywall and the auto-invest agent. Also the setup scripts, tests, and parts of the frontend (wiring it to the live API) |
| **Google Antigravity (Gemini)** | Most of the frontend in `web/`: the landing page, the four portals, the HashPack wallet panel and the trust views |
| **Claude (chat)** | Research, planning, and the early drafts of the PRD and overview |
| **Me** | Product decisions, architecture choices, the specs, every review, the testnet accounts and keys, and the final README and demo |

## How the work was split

- **Backend first, frontend on top.** Claude Code built the token lifecycle first, because it alone qualifies the Tokenize track. The frontend started on mock data and was switched to the live API once the routes existed.
- **One tool per folder.** Each tool kept to its own folders. Both read `docs/PRD.md`, `docs/OVERVIEW.md` and `docs/API.md`, which lists every route and data shape, so the frontend could be built against the API before the backend finished.
- **Commit before switching tools,** so each tool's changes are easy to see and undo.
- **The docs are the contract.** When the backend changed a route or number, `docs/API.md` was updated in the same session, and the frontend was told to follow it.

## Human-in-the-loop rules

These rules were given to the tools at the start of sessions and applied throughout:

1. **No auto-commits.** The tools never commit or push. I read the diff and commit myself.
2. **Ask before spending over 15 HBAR.** Any step that could cost more than 15 test HBAR needs my approval. The backend enforces this too: `MAX_STEP_HBAR` (default 15) makes it refuse such a transaction with `402 APPROVAL_REQUIRED`.
3. **Keys never in code.** Private keys live only in the root `.env`, which is in `.gitignore`. They are never pasted into prompts, logs or commits. The tools are told not to read `.env`.
4. **Stay in your own folder.** The backend tool doesn't edit `web/`, the frontend tool doesn't edit `backend/`, and documentation tasks edit only the README and `docs/`.
5. **Fail safe, never fake.** If a risk or trust check fails, the API returns an error. It never returns a default "safe" result.

## How output was reviewed and tested

- **Every diff on payment and token code was read by me** before it was committed.
- **Real testnet runs, not just unit tests.** The full lifecycle was run on Hedera testnet, and each step was checked on HashScan: deploy, allowlist, issue, buy, pay a supplier, pause, freeze, repay, burn, pay out. The transactions are listed in the README.
- **Test scripts in `backend/scripts/`:** `test:risk` and `test:trust` check the scorecard and trust layer against the planted fraud and trust stories and spend no HBAR. `test:x402` checks the paywall, sessions and agent rules against a fake facilitator. `test:api` and `test:auth` check the routes and logins. `test:x402:live` makes real payments.
- **Crash tests.** A test-only switch (`UDHAAR_CRASH_AT`) stops the server at chosen points to prove that a crash during repayment never pays anyone twice.
- **Numbers checked by hand.** Prices, fees and rounding were checked against real transactions, such as the 1% uINR fee rounding down. Where a source couldn't be confirmed, the docs say so (see `docs/DATA.md`).
- **Honest labelling.** Simulated data and mock integrations are marked in the code, the API responses, the UI and the docs.
