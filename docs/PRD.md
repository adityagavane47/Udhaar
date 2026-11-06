# Udhaar — Product Requirements (PRD)

Nov 4, 2026 · @ADITYA

## Summary

Udhaar is an invoice-financing app on Hedera: small businesses tokenize buyer-confirmed invoices with the Asset Tokenization Studio, KYC-verified investors buy them at a discount, repayment is automatic at maturity, a risk API sells explainable scores per call over x402, and a trust layer checks the business, the invoice and the buyer. It is built solo at ETHGlobal Mumbai (5–7 Nov 2026); this PRD defines what must ship.

**Problem.** Small suppliers wait months for large buyers to pay invoices, while they need cash now for wages and stock. Investors could fund these invoices, but they cannot judge which buyers will pay, and fake invoices are a known fraud.

**Solution.** Turn each confirmed invoice into a compliant security token, sell fractions to verified investors, settle and redeem on-chain, and price each invoice from a transparent risk score that includes graph-based fraud detection.

Companion document: *Udhaar — Project Overview and Build Plan* (architecture, data, schedule, demo script).

## Goals and success metrics

The product goal is a working end-to-end invoice lifecycle on Hedera testnet; the hackathon goal is at least third place in the Hedera Tokenize track.

**Goals**

1. Tokenize a buyer-confirmed invoice with ATS and run its full lifecycle: issue, KYC-gated sale, freeze, redemption at maturity.
2. Give investors an explainable risk score, sold per call over x402, that also catches planted fraud patterns.
3. Let an AI agent invest within rules, paying for research on its own.
4. Make the whole flow clickable by anyone on a live link.

**Non-goals (this hackathon)**

- Real KYC, real company data or real money (the trust layer's GST registry, e-invoice signer, bureau and MSME data are mocks)
- Mainnet deployment, audits or legal structuring
- A secondary market for invoice tokens
- Mobile apps or multi-language UI

**Success metrics**

| Metric | Target |
| --- | --- |
| Tokenize track qualification items met | 4 of 4 |
| Tokenize bonus items hit | 5 of 5 |
| x402 track qualification items met | 4 of 4 (if dual entry allowed) |
| ETHGlobal finalist eligibility | All 4 rules met |
| Demo scenarios that run live without errors | 4 of 4 (clean, new buyer, fraud ring, repayment) |
| Planted fraud patterns caught | 3 of 3 (ring, hidden owner, shared address) |
| Outcome | Top 3 in Tokenize track |

## Users

Four roles share one web app; each signs with its own testnet account.

| Persona | Role | Needs | Pain today |
| --- | --- | --- | --- |
| Ramesh, cement supplier, Pune | Business | Cash now against unpaid invoices | Waits 60–120 days; bank loans need collateral |
| BigBuild Ltd, construction company | Buyer | Pay on its normal terms; no extra work | Suppliers chase it for early payment |
| Priya, retail investor | Investor | Short-term returns with clear, honest risk | Cannot judge buyers; fears fake invoices |
| Priya's agent | Investor's AI | Rules, a budget and paid data | Paid APIs need sign-ups and keys |
| Platform operator | Admin | Approve KYC, issue tokens, stop fraud | Fraud is hard to spot in flat records |

## User stories

Each story maps to the functional requirements below.

**Business**

- As a supplier, I upload an invoice with buyer, amount, due date and PDF, so I can get it funded.
- As a supplier, I see where my invoice is (submitted, confirmed, tokenized, funded, repaid), so I know when cash arrives.
- As a supplier, I receive the funding in my account with a HashScan link as proof.

* As a supplier, I pay my own suppliers with part of my invoice token, so they get paid without waiting for my cash.
* As a supplier, my invoice is checked against a public registry, so investors trust it has not been financed twice.

**Buyer**

- As a buyer, I confirm or reject invoices raised against me, so nobody can sell a fake debt in my name.
- As a buyer, I pay the invoice on the due date, and investors are repaid without any further work from me.

**Investor**

- As an investor, I complete KYC once and then can buy any listed invoice.
- As an investor, I browse listed invoices with amount, discount, due date and grade.
- As an investor, I pay a small fee for a full risk report with reasons and a graph, so I understand the risk before buying.
- As an investor, I buy units and track expected returns and repayment dates in my portfolio.
- As an investor, I set rules for an agent that checks and buys invoices for me within a budget.

**Admin**

- As the operator, I approve or reject KYC requests, seeing a scan of the applicant's wallet.
- As the operator, I issue a token for each confirmed invoice with the right compliance settings.
- As the operator, I see the whole business network in 3D with fraud patterns highlighted.
- As the operator, I freeze or pause a token when fraud is found.
- As the operator, I see every action in an audit log with transaction links.

## Functional requirements

P0 items qualify the Tokenize track and must ship; P1 items add bonus points and the x402 track; P2 items are stretch.

| ID | Requirement | Priority |
| --- | --- | --- |
| F1 | One web app with a role switcher (Business, Buyer, Investor, Admin); each role signs with its own testnet account | P0 |
| F2 | Business uploads an invoice (buyer, amount, due date, PDF) and sees its status tracker | P0 |
| F3 | Buyer confirms or rejects an invoice; confirmation is recorded on-chain | P0 |
| F4 | Admin issues an ATS bond-style token per confirmed invoice: units of fixed face value, maturity = due date | P0 |
| F5 | Token transfers allowed only for KYC-allowlisted accounts | P0 |
| F6 | Simulated KYC: investor form, admin approve or reject, allowlist update | P0 |
| F7 | Investor buys units at the discounted price; payment in test stablecoin goes to the supplier | P0 |
| F8 | Admin freeze, pause and unfreeze per token | P0 |
| F9 | Redemption at maturity pays every holder face value per unit | P0 |
| F10 | HashScan link shown for every on-chain action | P0 |
| F11 | Demo dataset generator (Faker, Indian locale) with the planted stories; the graph checks run in memory behind a `GraphStore` interface, so Neo4j can replace them | P1 |
| F12 | Risk scorecard (credit 100-point score, grade, confidence, discount, reasons) | P1 |
| F13 | Graph fraud checks: shared director, circular invoicing, shared address, unconfirmed invoice | P1 |
| F14 | Anomaly flag: an amount over 10× the supplier's usual raises a warning (built as a rule; the Isolation Forest was not built) | P1 |
| F15 | Full risk report behind x402, ₹1.00 in uINR per call, settled on Hedera | P1 |
| F16 | Auto-invest agent: rules, budget, pays for reports and buys with no human approval, shows a receipt | P1 |
| F17 | Admin network graph with fraud patterns highlighted; investor 2D mini-graph with masked names. The report returns graph data with masked names; the 3D view is not confirmed built | P1 |
| F18 | Repayment triggered by a Scheduled Transaction on the due date. **Not built:** the backend triggers repayment when it sees the buyer's payment, because a scheduled transaction lasts about 62 days at most | P1 |
| F19 | KYC wallet scan against known scam wallets. **Not built** | P1 |
| F20 | Audit log of all actions | P1 |
| F21 | Price feed (fair value per token) over x402 | P2 |
| F22 | uINR, a test rupee stablecoin (HTS token with a 1% custom fee), used for units and x402 reports | P0 |
| F23 | Atomic swap contract (stablecoin for units in one step) | P2 |
| F24 | Report fee split across engines in one atomic transfer | P2 |

**Added on 5 Nov**

| ID | Requirement | Priority |
| --- | --- | --- |
| F25 | Pay your supplier: a business transfers some of its invoice-token units to its own KYC-verified supplier as payment; that supplier is repaid by the buyer at maturity | P1 (headline differentiator) |
| F26 | Double-financing guard: invoice fingerprint (hash) written to an HCS topic at upload; a second upload of the same invoice is rejected with HashScan proof | P1 |
| F27 | Investor protection pool: 1% of each funding routed to a pool account through an HTS custom fee | P1 |
| F28 | Contribution back: a genuinely useful pull request to the ATS repo (docs fix, example or bug report), linked in the README | P1 |
| F29 | Credit passport: page showing a business's on-chain repayment history. Built as `GET /trust/company/:id` and the company trust page | P2 |

F8 demo shows both freeze and pause.

### Trust layer

Added on 6 Nov to answer the investor's three questions: is the business real, is the invoice real, will the money come back? The investor's real risk is the buyer, so the Trust Score covers the buyer as well as the seller. Real on Hedera: repayment history, buyer confirmations and the duplicate registry. Mock: the GST registry, the e-invoice signer, bureau scores, MSME-1 dues and Samadhaan complaints. Details are in [API.md](API.md#trust) and [DATA.md](DATA.md#trust-data-mock).

| ID | Requirement | Priority |
| --- | --- | --- |
| F30 | GSTIN check (format, state code, checksum) and a lookup in a mock GST registry: status, legal name, last 6 returns | P1 |
| F31 | Mock IRP e-invoice: a signed QR (ES256) is verified against the invoice at upload; a tampered one returns `422 EINVOICE_*` | P1 |
| F32 | Per-invoice trust checklist (`GET /trust/:invoiceId`): each item passes, warns, fails or is not provided, and names its source (`mock`, `hedera` or `udhaar`) | P1 |
| F33 | Udhaar Trust Score, 300–900, for the seller and the buyer (`GET /trust/company/:id`). Payment history comes from on-chain repayments | P1 |
| F34 | Cold start: "New on Udhaar" label, and invoices capped at ₹1,00,000 until 3 on-time repayments (`422 TRUST_LIMIT_EXCEEDED`) | P1 |

## Risk API and x402 specification

The risk API exposes one free and one paid route (plus the trust routes below); the paid route follows the x402 pattern and settles in uINR (`0.0.11327250`) through a Hedera facilitator.

| Route | Access | Returns |
| --- | --- | --- |
| `GET /risk/:invoiceId/summary` | Free | Grade and confidence |
| `GET /risk/:invoiceId/report` | x402, ₹1.00 in uINR | Full report (below) and investor mini-graph data |
| `POST /risk/:invoiceId/buy-report` | Investor session | The same report, paid by the server with the investor's key |
| `GET /.well-known/x402` | Free | Lists the paid endpoint for agents |
| `GET /trust/:invoiceId`, `GET /trust/company/:id` | Free | Trust checklist and Trust Score |
| Price feed (P2) | Not built | Fair value per unit from grade and days to maturity |
| `GET /health` | Free | Service status |

**Paid call flow:** a request without payment gets `402 Payment Required` listing network `hedera:testnet`, asset (uINR), amount, receiving account and resource. The payer needs ₹1.01, because uINR's 1% fee is charged on top and goes to the protection pool. The client retries with a signed payment in the payment header; the facilitator verifies and settles; the response carries the report and the settlement transaction ID. The payment header is `PAYMENT-SIGNATURE`; field names are in [API.md](API.md#get-riskinvoiceidreport).

**Report fields**

```json
{
  "invoiceId": "INV-0042",
  "riskScore": 85,
  "grade": "A",
  "confidence": "HIGH",
  "creditRisk": "LOW",
  "fraudFlags": [],
  "anomaly": false,
  "annualRatePct": 12,
  "daysToDue": 90,
  "suggestedDiscountPct": 2.9589,
  "reasons": ["Buyer paid 90% of past invoices on time"],
  "graph": {"nodes": [], "links": []},
  "settlement": {"transactionId": "0.0.9185802@..."}
}
```

**Rules:** grade thresholds A ≥80, B 65–79, C 50–64, D below 50 (not listed). The suggested discount is the grade's annual rate (A 12%, B 16%, C 20%) × days to the invoice's due date / 365; the example above is due in 90 days. New buyers get a neutral payment-history score and `confidence: LOW`. Any fraud flag sets grade D. If the scoring or graph service is down, the route returns an error and no payment settles; it never returns a default "safe" result.

## Non-functional requirements

Security and honesty matter more than features: the app handles money flows, so it must fail safe and never fake a result.

| Area | Requirement |
| --- | --- |
| Keys | Private keys only in environment variables; `.env` in `.gitignore` before the first commit; never in prompts or logs |
| Privacy | No personal data on-chain; only "wallet verified" status. Full graph admin-only; investor views mask names |
| Fail-safe | Errors return errors; no mock or default "safe" risk results; failed paid calls do not settle |
| Honesty | Simulated KYC and data labelled in the UI footer, README and video |
| Explainability | Every score shows its reasons; no unexplained black-box decision |
| Reliability | Every demo scenario runs from the live link; a recorded backup video exists |
| Performance | Risk report returns in under 5 seconds; graph view stays under \~150 nodes |
| Usability | One site, role switcher, readable at laptop and phone width |
| Openness | Public repo; README with setup, architecture, payment flow, transaction and contract links |

## Assumptions and open questions

The plan rests on three assumptions about Hedera tooling that must be checked in the first hours of the event.

**Assumptions**

- ATS can issue a bond-style token with a maturity date, KYC allowlist and freeze, and redeem it at maturity. (Confirmed on testnet.)
- A Scheduled Transaction can trigger repayment on the due date. Outcome: not used. The backend triggers repayment when it sees the buyer's payment.
- uINR is held by the investor and accepted by the x402 facilitator. Both were tested on testnet on 6 Nov 2026.
- Rupee amounts are display-only; settlement uses a stablecoin at a fixed demo rate stated in the README.
- Project code is written during the event; only accounts, research and these documents are prepared beforehand.

**Out of scope:** real KYC providers, real company or GST data, secondary trading, buyer default handling beyond a "defaulted" status, mainnet.

**Open questions (ask at the Hedera booth on day 1)**

- [ ] Can one project be submitted to both the Tokenize and x402 tracks?
- [x] Redemption is triggered by the issuer (`fullRedeemAtMaturity`), per holder.
- [ ] How are ATS contracts verified on HashScan for the "contracts verified" requirement?
- [x] Test USDC is no longer needed: x402 reports settle in uINR.

## Acceptance criteria

The build is done when every P0 item below passes from the live link in a private browser window.

**P0 — Tokenize track**

- [ ] Ramesh uploads an invoice; BigBuild confirms it; the confirmation is visible on HashScan
- [ ] Admin issues an ATS token for it; the token appears on HashScan with maturity and supply
- [ ] An unverified wallet's purchase is rejected by the token; a KYC-approved investor's purchase succeeds
- [ ] Ramesh's account receives the funding
- [ ] Admin freezes the token and a transfer then fails; unfreeze restores it
- [ ] At maturity, holders receive face value per unit

**Added features**

- [ ] Ramesh transfers 100 units to his sand supplier's verified account; a transfer to an unverified account fails
- [ ] Uploading the same invoice twice is rejected, with the first upload's HCS record shown
- [ ] Each funding sends 1% to the protection pool account, visible on HashScan
- [ ] ATS pull request opened and linked in the README

**P1 — Risk, x402 and agent**

- [ ] Clean buyer scores Grade A; new buyer scores Grade C with low confidence
- [ ] Fraud ring, hidden owner and shared address are each flagged
- [ ] Unpaid call to the risk report returns 402; paid call returns the report and a settled transaction ID
- [ ] Auto-invest agent checks several invoices, pays for each report, buys only those passing its rules, with no human click
- [ ] Admin 3D graph highlights the fraud ring; investor mini-graph masks names

**Release checklist**

- [ ] Live deployment reachable by anyone with the link
- [ ] Video 2–4 minutes, 720p or better, no music, covering issuance, configuration and a lifecycle operation, with HashScan links
- [ ] Public repo; README with setup, architecture, payment flow, transaction IDs, contract links, simulated-data note
- [ ] Every submission field filled; Hedera prizes selected; AI tools disclosed as required
