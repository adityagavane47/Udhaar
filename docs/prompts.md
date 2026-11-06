# Main prompts

**This is a summary.** It lists the main prompts in order, reconstructed from the repo history and docs. It is not a verbatim log, and the wording is paraphrased. Each line is one session or step.

## Planning

1. **Idea and track research.** Compare the Hedera tracks, pick invoice financing, and check what ATS, x402 and Stablecoin Studio can do.
2. **Overview and PRD.** Write the build plan and the product requirements, with priorities, acceptance criteria and a demo script (`docs/OVERVIEW.md`, `docs/PRD.md`).
3. **Hackathon setup.** Create the testnet role accounts and keep the keys out of any repo.

## Backend (Claude Code)

4. **ATS bond.** Deploy a v8 bond through the factory, allowlist an account, issue units, transfer, and show that a non-allowlisted account is rejected.
5. **uINR stablecoin.** Create an HTS rupee token with a 1% custom fee to a POOL account, and test the fee on real transfers.
6. **Full bond lifecycle.** Pause, freeze, repayment detection on the mirror node, and burn-then-pay redemption for every holder.
7. **Backend API.** Invoices, buyer confirmation on HCS, KYC, buy, pay-your-supplier, token controls, and a duplicate-invoice registry. Document every route in `docs/API.md`.
8. **Time-based pricing.** Replace the flat 4% discount with annual rate × days to the due date / 365.
9. **Risk engine.** Generate a simulated dataset with planted stories, then build the scorecard, graph fraud checks and anomaly flag (`docs/DATA.md`).
10. **x402 paywall and agent.** Gate the risk report behind x402 in uINR through the official facilitator, then build the auto-invest agent with rules in plain code and an HCS audit log.
11. **Trust layer.** Add GSTIN checks, a mock GST registry, a mock IRP-signed e-invoice, the 300–900 Trust Score, the per-invoice limit for new companies, and the trust routes.

## Frontend (Antigravity, with Claude Code for wiring)

12. **Four portals on mock data.** Business, Buyer, Investor and Admin, built against `docs/API.md`.
13. **Connect to the live backend.** Replace the mock API with real calls and show a HashScan link on every action.
14. **Pricing and risk reports in the UI.** Time-based pricing, demo maturity labels, and the paid risk report.
15. **Persona login and admin session.** Fix persona login and guard the admin portal with a session.
16. **HashPack wallet panel.** Read-only WalletConnect connection.
17. **Landing page.** One invoice story, no overlapping elements, a working back button.
18. **Trust panel.** Show the trust checklist and Trust Score for an invoice and a company.

## Wrap-up

19. **Docs pass.** Rewrite the README for a judge with two minutes, add `AI_USAGE.md` and this file, replace USDC with uINR in the overview and PRD, and fix numbers and routes that didn't match the code.
