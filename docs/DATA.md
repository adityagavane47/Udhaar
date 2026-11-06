# Udhaar risk dataset

**All of this data is simulated.** Every company, person, address, phone number and invoice is made up, apart from the two demo personas described under [Real accounts](#real-accounts), which are fictional too. There's no public dataset of Indian invoices, so the risk engine runs on this one.

- **Files:** `backend/data/risk/` (committed as seed data)
- **Generator:** `backend/scripts/generate-data.ts`
- **Regenerate:** `cd backend && npm run generate-data`
- **Test:** `cd backend && npm run test:risk` (spends no HBAR)

The seed is fixed (`20261101`), and so is the reference date (`2026-11-01`). Regenerating gives byte-identical files, and the test checks this.

## What's in it

| File | Rows | Fields |
| --- | --- | --- |
| `companies.json` | 50 | `id` (GSTIN format), `name`, `type`, `foundedYear`, `size`, `gstFilingRate`, `city`, `address`, `phone` |
| `directors.json` | 80 | `id`, `name`, `companyIds` |
| `invoices.json` | 500 | `id`, `supplierId`, `buyerId`, `amount`, `issueDate`, `dueDate`, `paidDate`, `status`, `discountRatePctPa` |
| `account-links.json` | 2 | Real account role → company ID |
| `manifest.json` | 1 | Seed, reference date, counts, measured calibration, and which IDs belong to which story |

`status` is `paid`, `overdue` (unpaid past its due date on the reference date) or `open` (unpaid and not yet due).

The scorer never reads the story list in the manifest. It finds the stories from the data alone, and only the tests use the list.

## Sources

### Delayed Payments Report 3.0: payment delays

[*Report on MSMEs' Access to Finance and Timely Payments*](http://fisme.org.in/docs/GAME-FISME-REPORT-FINAL.pdf), by GAME, FISME and C2FO, released in November 2025. [C2FO](https://in.c2fo.com/resources/working-capital/delayed-payments-report-3-0-a-national-view-of-msme-payment-delays/) and [SMEStreet](https://smestreet.in/infocus/delayed-payments-report-30-highlights-msme-finance-progress-10816194) call it Delayed Payments Report 3.0.

| What the report says | Where | How it's used |
| --- | --- | --- |
| Firms with up to ₹5 crore revenue have an average debtor period **more than double** the next larger segment's and **almost triple** the largest segment's (₹50–250 crore) | Pages 3–4 | The ratios between size classes. The generator refuses to write data that misses them |
| Section 43B(h) expects payment to MSME vendors within **45 days** | Page 8 | The anchor for the medium class, and one of the payment terms |
| Delayed receivables were ₹8.13 lakh crore in March 2024, or ₹7.34 lakh crore adjusted for inflation | Page 2 | Background only |

I read pages 1–27, which include the whole chapter on timely payments, and pages 60–69 of the scanned PDF. **Those pages give no day counts by size.** I didn't read pages 28–59, which cover access to credit, TReDS and GST, so a table there can't be ruled out.

### Discount rates

The range of **6.5–9% a year comes from the project brief, and I couldn't confirm it.** The closest source I found is [M1xchange](https://www.m1xchange.com/treds-is-financial-lifeline-for-msmes-remedy-for-problem-of-late-payments-sundeep-mohindru-m1xchange/), a TReDS platform, which quotes 7–11% a year. Treat 6.5–9% as an assumption.

`discountRatePctPa` is only stored as data. Neither the scorecard nor the price uses it. Real prices use the grade rates of 12%, 16% and 20% a year in [API.md](API.md#post-invoicesidtokenize), which are a project decision and sit above this range.

## Assumptions

These are my choices, not sourced facts.

**Payment delays.** Only the ratios come from the report, so the day counts are built up from the 45-day rule:

| Supplier size | Revenue | Target days to payment | Measured in the data |
| --- | --- | ---: | ---: |
| Micro | Up to ₹5 crore (report) | 122 | 123 |
| Small | ₹5–50 crore (assumed: the report doesn't give this range in the pages read) | 56 | 58 |
| Medium | ₹50–250 crore (report) | 43 | 45 |

Measured, micro firms wait 2.12× as long as small firms and 2.73× as long as medium firms. The measurements cover paid background invoices only. Each buyer has its own speed (0.75–1.3× the target), with random variation on top.

**Everything else:**

| Item | Assumption |
| --- | --- |
| Payment terms | 30, 45 or 60 days. 45 is twice as likely as the others |
| Invoice amounts | Typical size is ₹75,000 (micro), ₹3 lakh (small) and ₹12 lakh (medium), with a wide spread. Rounded to ₹1,000 so every invoice divides into units |
| GST filing rate | 78–99% unless a story sets it |
| Founding years | 1998–2021 unless a story sets it |
| Discount rate per invoice | Follows how promptly the buyer pays, within 6.5–9% |
| Billing direction | Background trade only flows one way, from suppliers to makers to buyers, so no loop forms by accident. Real supply chains can have innocent loops, so a real system would need a stricter check |

**Keeping it fictional:**

- **IDs:** each one has a valid GSTIN format with a deliberately wrong check digit, so it can't be a real taxpayer's ID. The test checks this.
- **Names:** people's names come from Faker's Indian locale, and company names combine invented word lists. A match with a real person or business would be an accident.
- **Phones and addresses:** these are generated too, and phone numbers use a `555` pattern. None has been checked against real records, so don't contact them.

## Planted stories

Each story has an open invoice, due 90 days after the reference date, that the demo scores. IDs for the companies involved are in `manifest.json`.

| Invoice | Story | How it's planted | Result |
| --- | --- | --- | --- |
| `DEMO-RELIABLE` | Reliable buyer | BigBuild Ltd has 30 settled invoices, 29 on time (97%) and one 3–8 days late. Founded 2003, files 99% of GST returns | 98, grade A, high confidence |
| `DEMO-LATE` | Late payer | 30 settled invoices: 26 are 20–40 days late, 4 are on time. Otherwise a strong profile | 56, grade C |
| `DEMO-NEW` | Brand-new buyer | Founded 2025, no settled invoices. This open one is its only record | 55, grade C, low confidence |
| `DEMO-RING` | Circular fraud ring | X bills Y, Y bills Z, Z bills X, with 4 past invoices per link. They trade with no one else | 49 (79 before the fraud cap), grade D, `CIRCULAR_INVOICING` |
| `DEMO-HIDDEN` | Hidden owner | One director sits on both the supplier's and the buyer's board | 49 (90 before the cap), grade D, `SHARED_DIRECTOR` |
| `DEMO-ADDRESS` | Shared address | Supplier and buyer are registered at the same address | 49 (64 before the cap), grade D, `SHARED_ADDRESS` |
| `DEMO-ANOMALY` | Amount anomaly | A supplier whose 12 past invoices centre near ₹50,000 bills ₹40 lakh, 87× its usual | 64, grade C, anomaly warning |

The hidden owner case shows why the graph matters: on credit alone that invoice would score 90.

Two background suppliers each share a director with another supplier they never bill. That overlap is deliberate and isn't fraud, because the check only looks at a supplier and buyer on the same invoice. Across all 500 invoices, the test found no fraud flags outside the planted pairs, and only the planted anomaly.

Of the 500, 72 grade A, 43 B, 118 C and 267 D. Most of the Ds are old background invoices: they're scored today, so they lose points for being past due, and many of those buyers pay small suppliers very late. This doesn't describe how the marketplace would look.

## Real accounts

`account-links.json` maps the two real demo accounts to dataset companies by role, so no account ID is hardcoded. Their profiles match the frontend's.

| Account | Company | Profile |
| --- | --- | --- |
| `BUYER_ID` | BigBuild Ltd | The reliable buyer story |
| `BUSINESS_ID` | Ramesh Cement Traders | Founded 2011, files 97% of GST returns, 14 past invoices at about ₹5 lakh, all paid on time |

**Any other account** isn't in the dataset, so it's scored as a new company with low confidence.

If `BUYER_ID` or `BUSINESS_ID` isn't set, the engine returns an error, because otherwise BigBuild would quietly score as a new company.

## The fraud case in the live demo

`DEMO-RING` is the only simulated invoice shown beside real ones.

- **Where it appears:** `GET /invoices` adds it with `seeded: true`, status `risk_checked` and its grade. It's added when the list is read, so it's never written to the store.
- **Its grade is real:** it comes from the engine each time. If the engine is down, the invoice is left out rather than shown with a guessed grade.
- **It can't be bought:** it has no token, because grade D can't be tokenized. Tokenizing returns `409 RISK_BLOCKED`, which is recorded in the audit log, and buying returns `409 SEEDED_INVOICE`.
- **It costs nothing:** it never touches the chain.

Its link points to the uINR token and says the invoice has no on-chain record, because the API includes a HashScan link on every response and there's no real one here.

## Limits

- **Real activity doesn't feed back.** Real invoices are scored against the dataset but aren't added to it, so a real late payment won't change a score, and a ring among real accounts wouldn't be found.
- **The scorecard is hand-tuned.** Its weights come from the brief and its sub-scores are my judgment. Nothing has been checked against real defaults.
- **No machine learning.** The anomaly check is the 10× rule, not the Isolation Forest in the PRD.
- **No wallet data.** The PRD's `wallets` and `scam_wallets` tables and its scam wallet story belong to the wallet scan (F19), which isn't built.
- **Deployment.** The store and seed data are both under `backend/data/` by default. A persistent disk mounted there would hide the seed data, so mount it elsewhere and set `DATA_DIR`.
