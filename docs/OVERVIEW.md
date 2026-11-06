# Udhaar — Project Overview and Build Plan

Nov 4, 2026 · @ADITYA

## The idea

Udhaar lets a small business sell an unpaid invoice to investors as a compliant security token on Hedera, so it gets cash today instead of in 90 days, while investors are repaid automatically on the due date and an AI agent sells risk scores over x402.

**The problem:** small Indian suppliers deliver goods to large companies and then wait months to be paid. They need working capital now to pay staff and buy stock. Bank loans are slow and need collateral.

**The answer:** the unpaid invoice is itself an asset. Investors buy it at a small discount today and collect the full amount when the buyer pays. This is called invoice discounting and it already exists in India; Udhaar shows it working faster, more openly and with automatic settlement on Hedera.

**Why the name:** udhaar is the everyday Hindi word for money owed on credit. Every unpaid invoice is udhaar, and the app turns it into cash today.

**Hackathon targets:** Hedera "Tokenize Anything with Hedera Studios" track (primary, aiming for a top-3 place), Hedera x402 agent-payments track (if one project may enter both), and ETHGlobal finalist judging.

## How it works

One invoice goes from upload to automatic repayment in eight steps; the demo follows Ramesh, a cement supplier owed ₹5,00,000 by BigBuild Ltd, due in 90 days.

1. **Upload.** Ramesh uploads the invoice: buyer, amount, due date, PDF. Its fingerprint goes to an HCS registry, so an invoice that was already financed is rejected.
2. **Buyer confirms.** BigBuild confirms on-chain that it owes the amount. Unconfirmed invoices never reach investors, which blocks fake invoices.
3. **Risk check.** The risk engine grades the invoice (credit, fraud, anomaly) and suggests a discount.
4. **Tokenize.** The admin issues the invoice through the Asset Tokenization Studio as a bond-like security token: 500 units of ₹1,000, maturity on the due date, KYC-only transfers.
5. **Investors buy.** KYC-verified investors buy units at a discount (₹970.41 each for a Grade A invoice due in 90 days). Ramesh receives about ₹4,85,000 today.
6. **Agents pay for research.** Before buying, an investor's auto-invest agent pays 0.01 USDC over x402 for each full risk report, with no human approving.
7. **Buyer pays.** On the due date BigBuild pays the full ₹5,00,000.
8. **Automatic repayment.** A Scheduled Transaction redeems the tokens and pays each investor ₹1,000 per unit. An investor who paid ₹97,041 for 100 units gets ₹1,00,000.

If fraud is found at any point, the admin freezes the token and nobody can move it.

**Pay your supplier with the token:** Ramesh owes his sand supplier ₹1,00,000. Instead of waiting for cash, he transfers 100 units of the BigBuild invoice token to the sand supplier's verified account, and the sand supplier is repaid by BigBuild at maturity. This is how the traditional hundi was endorsed and passed down a trade chain, and it reaches the deeper-tier suppliers that TReDS does not.

**Money on testnet:** amounts are shown in rupees for the story, but settle in a stablecoin on testnet: test USDC, or a demo rupee stablecoin minted with Stablecoin Studio (stretch). The demo exchange rate is fixed and stated in the README.

## Roles and portals

One website with a role switcher at the top (Business · Buyer · Investor · Admin); each role signs with its own testnet account, so every click is a real on-chain action.

| Portal | Who | Screens |
| --- | --- | --- |
| Business | Supplier (Ramesh) | Dashboard of money received; upload invoice; invoice list with status tracker (Submitted → Buyer confirmed → Risk checked → Tokenized → Funded → Repaid); payment received with HashScan link; pay a supplier with invoice units |
| Buyer | BigBuild Ltd | Invoices to confirm (Confirm / Reject); upcoming payments; Pay on the due date |
| Investor | Priya | KYC form and status; marketplace of live invoices with basic grade; invoice detail with paid full risk report and mini-graph; buy units; portfolio with expected returns; auto-invest agent rules |
| Admin | Platform | KYC approvals with wallet scan; invoice review and Create token; full 3D fraud graph; token controls (Freeze, Pause, Unfreeze); lifecycle calendar; audit log |

**Privacy rule:** the full 3D network graph is admin-only, because it reveals who trades with whom. Investors see only a small 2D graph for the invoice they are viewing, with people's names masked ("Director A"). Businesses and buyers see no graph.

**KYC:** simulated for the demo. The investor fills a form, the admin approves, and only then is the wallet added to the token's allowlist. No personal data goes on-chain, only "this wallet is verified". The README states that production would use a licensed KYC provider.

## Risk score

Each invoice gets a score out of 100 from an explainable points system, plus fraud and anomaly flags that can cut the score or block the invoice outright. A points system is used instead of a trained model because there is no real training data and finance decisions must be explainable.

**Credit score (will the buyer pay?)**

| Category | Max points | Inputs |
| --- | --- | --- |
| Payment history | 40 | Share of past invoices paid on time; average days late |
| Company profile | 25 | Company age, size, GST filing regularity, registration active |
| This invoice | 20 | Amount versus the buyer's usual; days until due |
| Network | 15 | Whether other suppliers get paid on time by this buyer |

A buyer with no history gets a neutral 20/40 for payment history, and the report says **Confidence: LOW**.

| Score | Grade | Rate a year | Discount if due in 90 days |
| --- | --- | --- | --- |
| 80–100 | A | 12% | 2.96% |
| 65–79 | B | 16% | 3.95% |
| 50–64 | C | 20% | 4.93% |
| Below 50 | D | Not listed | Not listed |

The discount is the annual rate × days to the invoice's due date / 365, so a shorter invoice gets a smaller discount.

**Fraud checks (graph, Neo4j)** — any hit blocks the invoice or sends it to the admin:

- Same person is a director of both supplier and buyer
- Circular invoicing (A bills B, B bills C, C bills A)
- Supplier and buyer share an address or phone
- Buyer has not confirmed the invoice on-chain

**Anomaly flag (Isolation Forest)** on real invoice features: amount versus the supplier's history, upload burst rate, unusual tenor. It raises a warning and lowers the score; it never decides alone.

**Wallet check:** investor and business wallets are checked against a list of known scam wallets and their direct links before KYC approval or payout.

**Report output:** score, grade, confidence, credit risk, fraud flags, anomaly flag, suggested discount and plain-language reasons (for example, "Buyer paid 90% of past invoices on time").

## Where x402 fits

The full risk report is a paid API: 0.01 USDC per report over x402 on Hedera, so investors and their agents pay per check instead of subscribing.

**Free:** marketplace listing with amount, due date, discount and basic grade.

**Paid (x402):** `GET /v1/risk-report/{invoiceId}` returns the full report and the investor's mini-graph.

1. Call without payment → `402 Payment Required` with price, USDC token, receiving account.
2. Client signs a USDC payment and retries with the payment header.
3. Facilitator verifies and settles on Hedera testnet; the API returns the report and the transaction ID.

**Auto-invest agent (qualifies the x402 track):** the investor sets rules once (budget, minimum grade, maximum per invoice). The agent then, with no human approving, scans new listings, pays for each risk report, buys units in invoices that pass, and shows a receipt: invoices checked, USDC spent on reports, amount invested.

**Stretch: price feed.** `GET /v1/price/{tokenId}` sells a fair value for each invoice token (from grade and days to maturity), the oracle-style NAV feed both tracks mention.

**Revenue split (stretch):** each report fee can be split between the credit engine, the fraud-graph engine and the platform in one atomic transfer.

## Hedera features and track requirements

The Tokenize track is the primary target; the x402 track is a second shot if Hedera confirms one project can enter both (ask at their booth on day 1).

**Tokenize track — qualification (all required)**

- [ ] Issue the invoice token with the Asset Tokenization Studio (bond: face value, maturity date)
- [ ] Deploy and demo on Hedera testnet
- [ ] Public GitHub repo; contracts verified on HashScan where applicable
- [ ] Video of 5 minutes or less showing issuance, configuration and at least one lifecycle operation (redemption at maturity, plus a freeze)

**Tokenize track — bonus points**

| Bonus | How Udhaar hits it |
| --- | --- |
| Compliance controls | KYC allowlist, transfer restrictions, freeze, pause |
| Custom fees and distributions | Repayment distributed to every investor; 1% of each funding goes to an investor protection pool |
| Oracle pricing or NAV | Paid price feed from grade and days to maturity (stretch) |
| Scheduled Transactions | Repayment scheduled for the due date |
| Contributions back | A genuinely useful pull request to the ATS repo (docs fix, example or bug report) |

**x402 track — qualification**

- [ ] x402-protected risk-report endpoint settling on Hedera testnet
- [ ] Auto-invest agent completes a paid request with no human approving
- [ ] README with setup, architecture, payment flow and a settled transaction ID
- [ ] Video of 5 minutes or less showing a payment settling, linked on HashScan

**ETHGlobal finalist eligibility:** live deployment anyone can open, 2–4 minute video at 720p or better with no music, every form field filled, public repo. One video of about 3.5 minutes covers all three.

**Smart contracts:** ATS deploys the security-token contracts; no custom Solidity is required. An optional swap contract (USDC for units in one step) is a stretch goal.

## Data

There is no public dataset of Indian invoices, so a Python script (Faker with Indian locale) generates a labelled demo dataset at the event, with fraud and risk stories planted on purpose. The README marks it as simulated.

| Table | Rows | Key fields |
| --- | --- | --- |
| companies | \~50 | id, name, type (supplier/buyer/both), founded\_year, gst\_filing\_rate, city, address, phone, hedera\_account |
| people | \~80 | id, name, company\_id, role (director/owner) |
| invoices | \~500 | id, supplier\_id, buyer\_id, amount, issue\_date, due\_date, paid\_date, status |
| wallets | \~60 | account\_id, owner, linked\_to\_scam |
| scam\_wallets | \~5 | account\_id, reason |

**Planted stories**

| Story | Pattern | What the demo shows |
| --- | --- | --- |
| Reliable buyer | 30 invoices, 95% on time | Grade A |
| Late payer | Usually 20–40 days late | Grade C |
| New buyer | Founded last year, no invoices | Grade C, low confidence |
| Fraud ring | X bills Y, Y bills Z, Z bills X | Blocked, loop glows red |
| Hidden owner | One person directs supplier and buyer | Blocked, shared director |
| Shared address | Supplier and buyer at one address | Flagged for admin |
| Anomaly | Usual ₹50k supplier bills ₹40 lakh | Anomaly warning |
| Scam wallet | Investor wallet funded by a scam wallet | KYC rejected |

The CSVs load into Neo4j for the graph checks; the scorecard and Isolation Forest read them directly.

## System architecture

One web app talks to three services: a backend that runs the invoice and token lifecycle, an auto-invest agent, and the x402 risk API; all of them settle on Hedera testnet.

&#91;embedded content: System architecture · 8 components\]

The risk API is the only paid service; the agent and the investor portal both pay it per report.

| Layer | Choice |
| --- | --- |
| Web app | Next.js, one site with a role switcher; react-force-graph for the 3D graph |
| Backend | Node + TypeScript, Hedera JS SDK, ATS SDK or web app |
| Risk API | Python FastAPI behind x402 middleware (or a Node gateway in front of it) |
| Data | Neo4j Aura free tier; CSVs from the Faker generator |
| Payments | Test USDC (HTS); x402 Hedera facilitator |
| Hosting | Vercel (web), Railway or Render (backend, agent, risk API) |

## Build plan

The token lifecycle is built first because it alone qualifies the Tokenize track; the risk engine, x402 and the 3D graph are added on top. Map hours to clock times once the official start is known.

&#91;embedded content: Build schedule · hours from hacking start\]

**Checkpoints (do not move on until each is true)**

- [ ] **H3:** public repo with `.env` in `.gitignore`; web app and backend deployed as hello-world; ATS running on testnet
- [ ] **H12, Tokenize gate:** invoice uploaded → buyer confirms → ATS bond issued with KYC list → investor buys units → redemption pays investors; freeze works; every step on HashScan from the live site
- [ ] **H20:** demo dataset generated and loaded into Neo4j; risk score and fraud checks live behind x402; auto-invest agent pays and buys with no human
- [ ] **H31:** admin 3D graph with fraud ring highlighted; investor mini-graph; scheduled redemption on the due date; KYC wallet scan; polished portals; pay-your-supplier transfer; double-financing guard; protection-pool fee; ATS pull request
- [ ] **H33, feature freeze:** bugs only; redeploy; rehearse the demo three times
- [ ] **H36:** video uploaded, README complete, every form field filled, live link checked in a private window

If a block runs late, cut from its own stretch items, never from H33–H36.

## Demo script and submission

The video runs about 3.5 minutes, which fits the Hedera 5-minute cap and ETHGlobal's 2-to-4-minute rule; the live judging demo follows the same order.

| Time | On screen | Point made |
| --- | --- | --- |
| 0:00–0:20 | Title | Small suppliers wait 90 days to be paid; Udhaar gets them cash today |
| 0:20–0:45 | Business: upload; Buyer: confirm | Only buyer-confirmed invoices are listed |
| 0:45–1:15 | Admin: approve KYC; create ATS bond token | Compliant security token: KYC-only, freezable |
| 1:15–1:50 | Investor agent pays 0.01 USDC for risk report, buys units; Ramesh pays his sand supplier with 100 units | x402 payment with no human approving; supplier funded |
| 1:50–2:30 | Flagged invoice; admin 3D graph shows fraud ring; Freeze | Fraud caught by the graph, stopped on-chain |
| 2:30–3:10 | Due date: buyer pays; scheduled redemption pays investors | Lifecycle operation, automatic |
| 3:10–3:30 | HashScan links, architecture | Every step is a real Hedera transaction |

Record at 1080p with voice only, from the live site, and keep this recording as the backup if the live demo fails in the judging line.

**Submission checklist**

- [ ] Project page: every field filled; Hedera prizes selected
- [ ] Video uploaded
- [ ] Live link checked in a private browser window
- [ ] Repo public; README with setup, architecture, payment flow, HashScan transaction and contract links, simulated-data note
- [ ] AI tools used disclosed as the rules require

## Risks, fallbacks and setup done

The biggest risk is the Asset Tokenization Studio taking hours to set up, so it is the first thing to get working at the event.

| Risk | Fallback |
| --- | --- |
| ATS setup slow or broken | Ask the Hedera booth on day 1; use the ATS web app to issue instead of the SDK |
| No test USDC (faucet limit) | Request again in the morning; ask Hedera; mint a demo stablecoin with Stablecoin Studio |
| Scheduled redemption not supported as planned | Admin triggers redemption manually on the due date in the demo |
| Neo4j or 3D graph runs late | Ship 2D graph; the fraud check still works |
| Live demo fails in judging | Play the recorded video; show HashScan history |
| Running out of time | Stop at the end of any checkpoint; everything shipped still qualifies |

**Setup already done (4 Nov)**

| Role | Testnet account |
| --- | --- |
| Admin | 0.0.11227777 |
| Business | 0.0.11310318 |
| Buyer | 0.0.11310319 |
| Investor | 0.0.11310320 |
| Risk agent | 0.0.11310322 |

All five hold test HBAR and can receive tokens automatically. Keys live in `accounts.env`, outside any repo. Test USDC is still pending because of the faucet limit.

**Working with Claude Code:** start each session with this doc and the PRD, build one feature per session, commit after each working step, never paste private keys into a prompt, and read every diff on payment and token code yourself.

**Tool split:** Antigravity (Google AI Pro) builds the frontend in `/web`; Claude Code builds the backend, Hedera integration and risk engine. Each tool keeps to its own folders, both get this doc, the PRD and an `API.md` of routes and data shapes, and you commit before switching tools.
