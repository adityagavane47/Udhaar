# Udhaar API

The backend service for the Udhaar frontend. It runs on Hedera testnet, and all data is simulated.

- **Base URL:** `http://localhost:4000` by default (`PORT` changes it)
- **Start it:** `cd backend && npm start`
- **Format:** JSON requests and responses

## Before you switch from mock data

- **Admin routes need a token.** Log in with the demo passcode and send the token on each admin call. See [Authentication](#authentication).
- **Investor routes need a session token.** `POST /invoices/:id/buy`, `POST /risk/:id/buy-report` and `POST /agent/run` need the token from `POST /auth/demo-investor`. Without it, buying returns `401`. See [Investor sessions](#post-authdemo-investor).
- **The full risk report is paid.** `GET /risk/:id/report` now returns `402` without a payment, so the frontend should call `POST /risk/:id/buy-report`. See [Risk](#risk).
- **Other routes are still open.** Anyone who can reach the server can call `confirm`, `pay-supplier` and `repay`, signed with the server's keys. They're only rate limited, so don't expose the server beyond a testnet demo.
- **Routes that spend HBAR are rate limited.** Handle `429 RATE_LIMITED`. See [Rate limits](#rate-limits).
- **Slow routes.** Routes wait for on-chain confirmation. Most take 5–30 seconds, `tokenize` takes about a minute, and `repay` takes about 15 seconds per holder. Show a loading state, and don't set a short client timeout.
- **Requests run one at a time.** State-changing routes are queued, so a slow `repay` delays other writes. GET routes aren't queued.
- **Accounts, not company IDs.** `supplierId`, `buyerId` and `investorId` are Hedera account IDs, such as `Company.hederaAccount` in the frontend. The server can only sign for accounts in its `.env`. Any other signer gets `422 NO_SIGNING_KEY`.

## Response format

**Every successful response** includes `hashscanUrl`, the main proof link, and most also include `links`:

```ts
interface Link { label: string; url: string; txId?: string }
interface TxResult { hashscanUrl: string; txId: string }
```

**Every error** has this shape:

```ts
{
  error: {
    code: string;          // Stable: branch on this
    message: string;       // Safe to show to users
    hashscanUrl?: string;  // Present when a chain object or transaction is involved
    links?: Link[];
    // Some codes add fields, listed under each route
  }
}
```

Input errors that never reach the chain have no HashScan link: `400 VALIDATION_ERROR`, `400 INVALID_JSON`, `404 ROUTE_NOT_FOUND`, `404 INVOICE_NOT_FOUND`, `404 KYC_NOT_FOUND`, `404 TOKEN_NOT_FOUND`, `409 SEEDED_INVOICE`, `422 NO_SIGNING_KEY`, `503 RISK_DATA_UNAVAILABLE`, `503 RISK_UNAVAILABLE`, and the login and rate limit errors below.

**`502 CHAIN_OPERATION_FAILED`** can be returned by any write route if a chain step fails. Retrying is safe, because finished steps are not repeated.

## Authentication

### POST /auth/demo-admin

Checks the passcode against `DEMO_ADMIN_PASSCODE` and returns a short-lived admin token. Spends no HBAR.

**Request**

```ts
{ passcode: string }
```

**Response `200`**

```ts
{
  ok: true;
  token: string;             // Treat as opaque
  tokenType: "Bearer";
  expiresAt: string;         // ISO
  expiresInSeconds: number;  // 1800 by default
  hashscanUrl: string;       // The uINR token: login itself has no on-chain step
  links: Link[];
}
```

**Errors**

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `INVALID_PASSCODE` | Wrong passcode |
| 429 | `RATE_LIMITED` | 10 failed attempts from this IP in 15 minutes. The right passcode is refused too until the window ends |
| 503 | `ADMIN_AUTH_NOT_CONFIGURED` | `DEMO_ADMIN_PASSCODE` isn't set on the server, so admin routes stay locked |

### Using the token

Send it on every admin route:

```
Authorization: Bearer <token>
```

| Admin route | Spends HBAR? |
| --- | --- |
| `POST /invoices/:id/tokenize` | Yes |
| `POST /kyc/:id/approve` | Yes, when there are live bonds |
| `POST /kyc/:id/reject` | No |
| `POST /tokens/:id/pause` and `/unpause` | Yes |
| `POST /tokens/:id/freeze` and `/unfreeze` | Yes |

Without a valid token, these routes return one of the following and nothing else happens:

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `ADMIN_TOKEN_REQUIRED` | No `Authorization: Bearer` header |
| 401 | `ADMIN_TOKEN_INVALID` | The token is damaged, or was issued before the server last restarted |
| 401 | `ADMIN_TOKEN_EXPIRED` | The token is out of date |

Tokens can't be refreshed, so on any of these codes, ask for the passcode again. A token lasts 30 minutes, and restarting the server ends every session.

### POST /auth/demo-investor

Starts a session for the demo's investor persona, Priya. It takes no passcode and no body, and spends no HBAR. Call it when Priya is selected.

**Response `200`**

```ts
{
  ok: true;
  token: string;             // Treat as opaque
  tokenType: "Bearer";
  expiresAt: string;         // ISO
  expiresInSeconds: number;  // 1800 by default
  persona: "investor";
  accountId: string;         // INVESTOR_ID
  hashscanUrl: string;       // The investor's account
  links: Link[];
}
```

Send it as `Authorization: Bearer <token>` on these routes:

| Route | Spends |
| --- | --- |
| `POST /invoices/:id/buy` | uINR and HBAR |
| `POST /risk/:id/buy-report` | ₹1.01 in uINR |
| `POST /agent/run` | uINR and HBAR |

**Errors on those routes:** `401 INVESTOR_TOKEN_REQUIRED`, `401 INVESTOR_TOKEN_INVALID` (damaged, or issued before the server last restarted), `401 INVESTOR_TOKEN_EXPIRED`. On any of these, get a new session and retry. The route itself can return `429 RATE_LIMITED` or `503 INVESTOR_NOT_CONFIGURED`.

Investor and admin tokens aren't interchangeable, so keep them separately and send the right one for each route.

**What this token doesn't do:** with no passcode, anyone who can reach the server can get one. It marks which persona a request is for, but doesn't prove who is asking. Spending is limited by the rate limits, the agent's daily cap and its rule maximums, so don't expose the server beyond a testnet demo.

### Rate limits

Limits count per client IP and are held in memory, so a restart clears them.

| Routes | Limit |
| --- | --- |
| `POST /invoices`, `/invoices/:id/confirm`, `/buy`, `/pay-supplier`, `/repay`, `POST /kyc/:id/approve`, `POST /tokens/:id/pause`, `/unpause`, `/freeze`, `/unfreeze` | 20 requests a minute, shared across all of them |
| `POST /invoices/:id/tokenize` | 5 requests in 10 minutes |
| `POST /auth/demo-admin` | 10 failed attempts in 15 minutes. Successful logins don't count |
| `POST /auth/demo-investor` | 30 requests in 15 minutes |
| `GET /risk/:id/report` | 60 requests a minute. A paid report takes 2 |
| `POST /risk/:id/buy-report` | 10 requests a minute |
| `POST /agent/run` | 5 requests in 10 minutes, plus 20 runs a UTC day across all callers |

Every request counts, even one the route then refuses. On admin and investor routes the token is checked first, so a request without a valid token doesn't use up the limit.

Other reads, `POST /kyc` and `POST /kyc/:id/reject` spend nothing and have no limit.

Over a limit, the server returns `429 RATE_LIMITED` and nothing runs:

```ts
{ error: { code: "RATE_LIMITED"; message: string; retryAfterSeconds: number } }
```

Use `retryAfterSeconds` rather than the `Retry-After` header, because browsers don't expose that header across origins.

### Server settings

Set these in `.env`, then restart the server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_ADMIN_PASSCODE` | None | Required for admin login |
| `DEMO_ADMIN_TOKEN_MINUTES` | `30` | How long an admin token lasts |
| `DEMO_INVESTOR_TOKEN_MINUTES` | `30` | How long an investor session lasts |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | The x402 facilitator. `https://api.testnet.blocky402.com` also works |
| `AGENT_DAILY_RUN_CAP` | `20` | Agent runs a UTC day, across all callers |
| `AGENT_MAX_REPORT_BUDGET` | `50` | The highest `reportBudget` allowed, in rupees |
| `AGENT_MAX_INVESTMENT_BUDGET` | `50000` | The highest `investmentBudget` allowed, in rupees |
| `SELF_URL` | `http://127.0.0.1:PORT` | How the server reaches its own paywall when it pays as the investor |
| `TRUST_PROXY` | `0` | Number of proxies in front of the server. Set it to `1` on Railway or Render, or all users share one rate limit |

## Data shapes

Field names match `web/lib/types.ts`, with the additions noted below.

### Invoice

```ts
interface Invoice {
  id: string;                 // "INV-0001"
  supplierId: string;         // Hedera account ID
  supplierName: string;
  buyerId: string;            // Hedera account ID
  buyerName: string;
  amount: number;             // Whole INR. Settles 1:1 in uINR
  issueDate: string;          // ISO
  dueDate: string;            // ISO
  status: "submitted" | "buyer_confirmed" | "tokenized" | "funded" | "repaid";
  invoiceNumber?: string;
  pdfName?: string;
  fingerprint: string;        // "sha256:..." recorded on HCS
  hashscanUrl: string;        // Latest on-chain step
  links: Link[];              // Every on-chain step so far

  // Set once tokenized
  tokenId?: string;           // Bond contract ID, "0.0.x"
  symbol?: string;            // Bond symbol
  maturityDate?: string;      // ISO. Can be earlier than dueDate for demos
  totalUnits?: number;
  unitFaceValue?: number;
  retainedUnits?: number;     // Units the business still holds
  discountPct?: number;       // Set once when tokenized, from the grade and days to dueDate. Up to 4 decimals. Invoices tokenized before this pricing keep 4%
  grade?: "A" | "B" | "C" | "D";  // The grade that set the price. "D" appears only on the simulated invoice
  gradedAt?: string;          // ISO
  unitPrice?: number;         // Discounted price per unit, to the paisa, e.g. 970.41
  availableUnits?: number;    // Same as retainedUnits

  registered: boolean;
  amountPaidBy: Record<string, number>;  // INR paid or credited, per account
  confirmation?: { message: string; signature: string; signedBy: string; hashscanUrl: string };
  repayment?: Repayment;

  // Server bookkeeping: ignore these
  confirmationPayload?: string;
  tokenization?: object;
}
```

**Differences from the mock:**

- `status` skips `risk_checked` for real invoices, because scoring isn't a step they wait on. Only the simulated fraud invoice uses it.
- `grade` is set when an invoice is tokenized, and `riskScore` is never included, because the score belongs to the full report. For a grade before then, call `GET /risk/:invoiceId/summary`.
- All units go to the business at tokenization, so `availableUnits = retainedUnits`. The mock's `total - retained - holders` formula won't work.

### Holder

```ts
interface Holder {
  accountId: string;
  name: string;
  units: number;          // Everything owned, including frozen units
  amountPaid: number;     // INR paid for or credited on these units
  frozen: boolean;        // True if any units are frozen
  frozenUnits: number;
  hashscanUrl: string;
}
```

### Repayment

```ts
interface Repayment {
  status: "in_progress" | "complete" | "needs_review";
  reviewReason?: string;
  detected?: { transactionId: string; hashscanUrl: string; from: string; memo: string; amountBaseUnits: number };
  holders?: RepaymentHolder[];   // The snapshot saved before the first burn
}

interface RepaymentHolder {
  name: string; evm: string; accountId: string;
  units: number;
  amountBaseUnits: number;       // uINR x 100
  burned: boolean; burnTxId?: string; burnHashscanUrl?: string;
  paid: boolean; paymentTxId?: string; paymentHashscanUrl?: string;
}
```

### KycRequest

```ts
interface KycRequest {
  id: string;
  fullName: string;
  walletAddress: string;       // "0.0.x"
  country: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  walletScan: "clean" | "flagged" | "not_checked";
  walletScanNote?: string;
  hashscanUrl: string;
  pendingBonds: string[];      // Bonds not yet joined, such as paused ones
}
```

**Difference from the mock:** `walletScan` adds `"not_checked"`. The scan (F19) isn't built, so the API doesn't report wallets as `"clean"`.

### AuditEntry

Matches the frontend's `Transaction`, with `txId` and `status` added.

```ts
interface AuditEntry {
  id: string;
  type: "invoice_upload" | "duplicate_rejected" | "buyer_confirm" | "buyer_payment" | "kyc_submit" | "kyc_approve" | "kyc_reject" | "risk_blocked" | "report_paid" | "agent_run"
      | "token_create" | "token_pause" | "token_unpause" | "holder_freeze" | "holder_unfreeze"
      | "units_buy" | "units_transfer" | "transfer_rejected" | "units_burn" | "holder_payout";
  description: string;
  actor: string;
  timestamp: string;
  hashscanUrl: string;
  txId?: string;
  invoiceId?: string;
  status: "success" | "rejected";
}
```

The types `report_paid` and `agent_run` may not be in the frontend's `TransactionType` yet.

## Invoices

### POST /invoices

Saves an invoice, checks its hash against the HCS registry, and records it there. Only the hash and invoice ID go on-chain.

The hash covers supplier, buyer, amount, due date and invoice number. It leaves out the PDF name, so renaming a file doesn't get around the check.

**Request**

```ts
{
  buyerId?: string;        // Defaults to BUYER_ID
  supplierId?: string;     // Defaults to BUSINESS_ID
  amount: number;          // Positive whole INR
  dueDate: string;         // ISO date
  invoiceNumber?: string;  // Set this: otherwise two real invoices with the same parties, amount and date look identical
  pdfName?: string;
  issueDate?: string;
  supplierName?: string;
  buyerName?: string;
}
```

**Response `201`**

```ts
{ invoice: Invoice; tx: TxResult; hashscanUrl: string; links: Link[] }
```

**Errors**

| Status | Code | Meaning |
| --- | --- | --- |
| 409 | `DUPLICATE_INVOICE` | Already registered. Adds `originalId`, `fingerprint`, and `hashscanUrl` pointing to the original HCS record |
| 422 | `SAME_PARTY` | Supplier and buyer are the same account |

### POST /invoices/:id/confirm

The buyer's account pays for an HCS message and signs its contents with the buyer's key. No request body. Calling it again returns the original confirmation.

**Response `200`**

```ts
{ invoice: Invoice; tx: TxResult; hashscanUrl: string; links: Link[] }
```

`invoice.status` becomes `buyer_confirmed`.

**Errors:** `409 BAD_STATUS`, `409 NOT_REGISTERED`

### POST /invoices/:id/tokenize

**Admin token required.** Scores the invoice, then deploys the bond, allowlists the business and all KYC-approved wallets, and issues every unit to the business. Costs about 10.5 test HBAR. A retry resumes the same bond, at the same price, rather than deploying another.

**The price comes from the risk grade and the time left until the invoice is due:**

```
discount % = annual rate × days to the invoice's dueDate / 365
unit price = unit face value × (1 - discount % / 100), to the paisa
```

| Grade | Rate a year | ₹1,000 unit, due in 30 days | ₹1,000 unit, due in 90 days |
| --- | ---: | ---: | ---: |
| A | 12% | ₹990.14 (0.9863% off) | ₹970.41 (2.9589% off) |
| B | 16% | ₹986.85 (1.3151% off) | ₹960.55 (3.9452% off) |
| C | 20% | ₹983.56 (1.6438% off) | ₹950.69 (4.9315% off) |
| D | Not listed | Refused, with nothing spent | Refused, with nothing spent |

- **Always the due date:** `maturityMinutes` and `maturityDate` move the bond's maturity for demos, but never change the price.
- **Days:** counted from the moment of tokenizing, with part of a day counting as a whole day.
- **Set once:** the price is saved with the plan, so a retry keeps it. Invoices tokenized earlier keep their 4% (₹960).

Sending `discountPct` now returns `400 VALIDATION_ERROR`.

**Request** (all optional)

```ts
{
  maturityMinutes?: number;  // Minutes from now, for demos. Wins over maturityDate
  maturityDate?: string;     // ISO. Defaults to the invoice's dueDate
  unitFaceValue?: number;    // Default 1000. Must divide the amount exactly
}
```

Maturity must be at least a minute away. An earlier time is moved to one minute out.

**Response `201`**

```ts
{ invoice: Invoice; links: Link[]; tx: TxResult; hashscanUrl: string; replayed: boolean }
```

`invoice.status` becomes `tokenized`.

**Errors**

| Status | Code | Meaning |
| --- | --- | --- |
| 409 | `RISK_BLOCKED` | Grade D. Adds `grade`, `riskScore`, `fraudFlags` and `reasons`, and is recorded in the audit log |
| 503 | `RISK_DATA_UNAVAILABLE`, `RISK_UNAVAILABLE` | The invoice couldn't be scored, so nothing was priced or spent |
| 409 | `BAD_STATUS` | Only buyer-confirmed invoices can be tokenized |
| 422 | `BAD_DUE_DATE` | No valid price: the invoice's due date has passed, or is so far away that the discount would reach 100%. Nothing is saved or spent |
| 422 | `BAD_MATURITY`, `BAD_FACE_VALUE` | Bad request values |
| 402 | `APPROVAL_REQUIRED` | The gas price pushed the deploy above the `MAX_STEP_HBAR` limit |

### POST /invoices/:id/buy

**Investor token required.** The investor pays the discounted price in uINR to the business, plus a 1% fee on top to POOL. The business then transfers the units. The server checks that the transfer would succeed before any money moves.

**Request**

```ts
{
  units: number;            // Positive whole number
  investorId?: string;      // Optional. If sent, it must be INVESTOR_ID
  idempotencyKey?: string;  // Recommended: a repeat with the same key is not charged again
}
```

**Response `201`**

```ts
{ purchase: Purchase; invoice: Invoice; links: Link[]; tx: TxResult; hashscanUrl: string; replayed: boolean }

interface Purchase {
  id: string; invoiceId: string; investorId: string;
  units: number; unitPrice: number;
  amountBaseUnits: number;  // uINR x 100, paid to the business
  feeBaseUnits: number;     // uINR x 100, paid to POOL on top
  status: "pending" | "paid" | "complete";
  paymentHashscanUrl?: string; unitsHashscanUrl?: string;
}
```

`invoice.status` becomes `funded`.

**Errors**

| Status | Code | Money moved? | Meaning |
| --- | --- | --- | --- |
| 401 | `INVESTOR_TOKEN_REQUIRED`, `INVESTOR_TOKEN_INVALID`, `INVESTOR_TOKEN_EXPIRED` | No | Get a new session |
| 403 | `NOT_THE_SESSION_INVESTOR` | No | `investorId` isn't the session's account |
| 422 | `NOT_ALLOWLISTED` | No | The wallet isn't KYC-approved |
| 409 | `BOND_PAUSED` | No | The token is paused |
| 409 | `INSUFFICIENT_UNITS` | No | The business doesn't hold that many units |
| 422 | `INSUFFICIENT_UINR` | No | The investor can't cover the price plus 1% |
| 409 | `MATURED` | No | The bond has matured |
| 409 | `REPAYMENT_STARTED` | No | Repayment has begun |
| 409 | `PURCHASE_IN_PROGRESS` | No | An unfinished purchase has a different unit count. Adds `purchaseId` |
| 502 | `UNITS_PENDING` | **Yes** | The investor paid but the units didn't move. Retry to finish, with no second charge. Adds `purchaseId` |

### POST /invoices/:id/pay-supplier

The business transfers units to a supplier. An unverified supplier's transfer is still sent, so the token's own rejection is on-chain as proof.

**Request**

```ts
{
  supplierId: string;
  units: number;
  amount?: number;          // INR value to show in the holder list. Defaults to units x face value
  idempotencyKey?: string;  // Recommended
}
```

**Response `201`**

```ts
{ invoice: Invoice; tx: TxResult; links: Link[]; hashscanUrl: string }
```

**Errors**

| Status | Code | Meaning |
| --- | --- | --- |
| 422 | `SUPPLIER_NOT_VERIFIED` | The token rejected the transfer. Adds `reason`, `txId`, and `hashscanUrl` for the failed transaction |
| 409 | `BOND_PAUSED` | The token is paused |
| 409 | `INSUFFICIENT_UNITS` | The business doesn't hold that many free units |
| 422 | `TRANSFER_REJECTED` | The token rejected it for another reason. Adds `reason` |
| 422 | `SUPPLIER_NOT_FOUND`, `SAME_PARTY` | Bad supplier account |

### POST /invoices/:id/repay

The buyer pays REPAYMENT with the bond symbol as the memo. The server detects that through the mirror node and saves a holder snapshot. For each holder, it burns their units and then pays units × face value in uINR. No request body.

Calling it again is always safe. It resumes unfinished work, and a finished repayment returns the same result with nothing sent.

**How it protects holders**

- **Nothing moves until every check passes:** the bond has matured, isn't paused, and has no frozen units or unfinished purchases; every holder can receive uINR; every burn simulates successfully; and REPAYMENT has enough HBAR.
- **No payment is sent twice:** each payout is recorded before sending, and the chain is searched for an earlier one before sending.
- **Payment follows the burn:** a holder is only paid once the chain's burn log matches the saved snapshot.

**Response `200`**

```ts
{ invoice: Invoice; repayment: Repayment; links: Link[]; tx: TxResult; hashscanUrl: string }
```

`invoice.status` becomes `repaid`.

**Errors**

| Status | Code | Buyer charged? | Meaning |
| --- | --- | --- | --- |
| 409 | `NOT_MATURED` | No | Too early. Adds `maturityDate` |
| 409 | `NOT_TOKENIZED` | No | No bond yet |
| 409 | `BOND_PAUSED` | No | Unpause first |
| 409 | `HOLDER_FROZEN` | No | Unfreeze first |
| 409 | `HOLDER_CANNOT_RECEIVE_UINR` | No | A holder has no free association slot |
| 409 | `BURN_WOULD_FAIL` | No | A burn failed its simulation |
| 409 | `REPAYMENT_NEEDS_HBAR` | No | Top up REPAYMENT with HBAR |
| 409 | `PURCHASE_PENDING` | No | Finish that purchase first. Adds `purchaseId` |
| 409 | `HOLDERS_DO_NOT_MATCH_SUPPLY`, `AMOUNT_MISMATCH` | No | Units don't add up to the invoice |
| 422 | `INSUFFICIENT_UINR` | No | The buyer can't cover the invoice |
| 502 | `BURN_FAILED` | Yes | Retry this route. That holder wasn't paid |
| 409 | `REPAYMENT_NEEDS_REVIEW` | Yes | Chain state differs from the snapshot, so it stopped. **Needs a person**, because retrying won't clear it |

### GET /invoices

```ts
{ invoices: Invoice[]; hashscanUrl: string; links: Link[] }
```

The list also includes one simulated invoice, `DEMO-RING`, so the demo can show a fraud case. See [The fraud demo invoice](#the-fraud-demo-invoice).

### GET /invoices/:id

```ts
{ invoice: Invoice; hashscanUrl: string; links: Link[] }
```

This also works for simulated invoices.

### GET /invoices/:id/holders

Current holders, read from the chain. Burned units no longer exist there, so after repayment `holders` is empty and `repaidHolders` shows who was paid.

```ts
{ invoiceId: string; tokenId: string | null; holders: Holder[]; repaidHolders: RepaymentHolder[]; hashscanUrl: string }
```

## Risk

Scores any real invoice, or any invoice in the simulated dataset (`DEMO-*` or `SEED-*`). The dataset is described in [DATA.md](DATA.md). The summary is free and the full report costs ₹1.00 over x402.

**If scoring fails, these routes return an error, and no payment is verified or settled.** They never fall back to a default score.

| Status | Code | Meaning |
| --- | --- | --- |
| 404 | `INVOICE_NOT_FOUND` | No such invoice |
| 503 | `RISK_DATA_UNAVAILABLE` | The risk data is missing, damaged or incomplete, or a demo account ID isn't set |
| 503 | `RISK_UNAVAILABLE` | A check failed while scoring |

### GET /risk/:invoiceId/summary

Free: grade and confidence only, for marketplace cards.

```ts
{
  invoiceId: string;
  seeded: boolean;           // True for simulated invoices
  grade: "A" | "B" | "C" | "D";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  hashscanUrl: string;
  links: Link[];
}
```

### GET /risk/:invoiceId/report

The full report, for ₹1.00 in uINR over [x402](https://docs.hedera.com/solutions/ai/x402). An x402 client can pay it directly. The frontend should use [`POST /risk/:invoiceId/buy-report`](#post-riskinvoiceidbuy-report), because the browser holds no key.

**1. Without a payment: `402`**

The same details are in the `PAYMENT-REQUIRED` header, which is what x402 clients read.

```ts
{
  x402Version: 2;
  error: string;             // "payment_required", or why a payment was refused
  reason?: string;           // More detail, when a payment was refused
  resource: { url: string; description: string; mimeType: string };
  accepts: [{
    scheme: "exact";
    network: "hedera:testnet";
    asset: "0.0.11327250";   // uINR
    amount: "100";           // Base units: ₹1.00
    payTo: "0.0.11310322";   // The risk agent
    maxTimeoutSeconds: 120;
    extra: { feePayer: string; name: "uINR"; decimals: 2; payerFeePct: 1; payerTotal: "101" };
  }];
  payment: {                 // The same details, in plain form
    price: 1; payerTotal: 1.01; currency: "uINR"; token: string; decimals: 2;
    amountBaseUnits: 100; payerFeePct: 1; payTo: string; network: string; resource: string;
  };
  hashscanUrl: string;
  links: Link[];
}
```

The payer needs ₹1.01, because uINR's 1% fee is charged on top and goes to POOL. The facilitator pays the HBAR fee, so the payer needs no HBAR.

**2. With a payment: `200`**

Retry with the signed payment in a `PAYMENT-SIGNATURE` header (`X-PAYMENT` also works). The server scores the invoice, the facilitator verifies and settles, and the server checks the transaction on-chain before releasing the report. The response is below, with the settlement added and a `PAYMENT-RESPONSE` header.

```ts
settlement: {
  transactionId: string;     // "0.0.9185802@1793927733.569018473"
  hashscanUrl: string;       // Also the top-level hashscanUrl
  payer: string;
  payTo: string;
  network: "hedera:testnet";
  token: string;
  amount: 1;
  feeToPool: 0.01;
  onChainConfirmed: boolean; // False if the mirror node hadn't caught up after about 16 seconds
  settledAt: string;
};
```

**Payment errors**

| Status | Code | Charged? | Meaning |
| --- | --- | --- | --- |
| 402 | None (`error` is text) | No | Unreadable, wrong amount or account, refused by the facilitator, or already used. One payment buys one report |
| 503 | `FACILITATOR_UNAVAILABLE` | No | The facilitator can't be reached |
| 503 | `PAYWALL_NOT_CONFIGURED` | No | `RISK_AGENT_ID` isn't set, so the route stays locked rather than going free |
| 502 | `SETTLEMENT_MISMATCH` | Possibly | The on-chain transaction doesn't pay the report price, or isn't the one signed. No report is released |
| 502 | `SETTLEMENT_UNCONFIRMED` | Possibly | The facilitator didn't answer and the payment isn't on-chain yet. No report is released. Check the link before paying again |

The report itself has this shape:

```ts
{
  invoiceId: string;
  seeded: boolean;
  supplier: { name: string; inDataset: boolean };
  buyer: { name: string; inDataset: boolean };
  amount: number;
  dueDate: string;
  riskScore: number;                  // 0-100. At most 49 with a fraud flag
  grade: "A" | "B" | "C" | "D";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  creditRisk: "LOW" | "MEDIUM" | "HIGH";  // From credit points only, so fraud or an anomaly doesn't change it
  fraudFlags: ("CIRCULAR_INVOICING" | "SHARED_DIRECTOR" | "SHARED_ADDRESS")[];
  anomaly: boolean;
  annualRatePct: number | null;       // 12, 16 or 20. null for grade D
  daysToDue: number;                  // Whole days to the invoice's dueDate. Zero or less once it has passed
  suggestedDiscountPct: number | null;  // annualRatePct × daysToDue / 365. null for grade D or when BAD_DUE_DATE would apply
  appliedDiscountPct?: number;        // The discount actually set, once tokenized
  reasons: string[];                  // Plain language, most serious first
  breakdown: {
    paymentHistory: { points: number; max: 40 };
    companyProfile: { points: number; max: 25 };
    thisInvoice: { points: number; max: 20 };
    network: { points: number; max: 15 };
    anomalyPenalty: number;
    scoreBeforeFraudCap: number;
  };
  scoredAt: string;
  graph: {
    nodes: {
      id: string;
      label: string;                  // People appear only as "Director A"
      type: "company" | "person" | "address";
      role?: "supplier" | "buyer";
      inDataset?: boolean;
      flagged: boolean;
    }[];
    links: {
      source: string;
      target: string;
      type: "invoice" | "billed" | "director_of" | "registered_at";
      flagged: boolean;
    }[];
  };
  hashscanUrl: string;
  links: Link[];
}
```

The report never includes people's names, addresses or phone numbers. An invoice priced by the risk engine is scored as of the moment it was priced, so its grade and discount stay the ones that set its price. Invoices tokenized earlier have no such moment, so their `suggestedDiscountPct` keeps falling as the due date nears, while `appliedDiscountPct` stays at 4.

**Differences from the frontend's `RiskReport`:** `suggestedDiscountPct` can be `null`, and the payment is `settlement.transactionId` rather than `paymentTx`.

### POST /risk/:invoiceId/buy-report

**Investor token required.** The server pays its own paywall with the investor's key and returns the report. It takes no body and usually takes about 5–15 seconds.

**Response `200`:** the same as the paid report, with `replayed` added.

```ts
{ /* the report */ settlement: Settlement; replayed: boolean; hashscanUrl: string; links: Link[] }
```

If this investor already paid for this invoice's report, by this route or through the agent, it returns a fresh report with the original settlement and `replayed: true`, and charges nothing.

**Errors**

| Status | Code | Charged? | Meaning |
| --- | --- | --- | --- |
| 401 | `INVESTOR_TOKEN_REQUIRED`, `INVESTOR_TOKEN_INVALID`, `INVESTOR_TOKEN_EXPIRED` | No | Get a new session |
| 404 | `INVOICE_NOT_FOUND` | No | No such invoice |
| 402 | `PAYMENT_REFUSED` | No | The facilitator refused the payment. Adds `reason` |
| 422 | `INSUFFICIENT_UINR` | No | The investor holds less than ₹1.01 |
| 503 | `RISK_DATA_UNAVAILABLE`, `RISK_UNAVAILABLE`, `FACILITATOR_UNAVAILABLE` | No | Try again later |
| 502 | `PAID_REQUEST_FAILED`, `SETTLEMENT_MISMATCH`, `SETTLEMENT_UNCONFIRMED` | Possibly | No report was returned |

### GET /.well-known/x402

Free. Lists the paid endpoint, so an agent can find it from the base URL alone. This is Udhaar's own format, and I haven't confirmed that a shared standard exists for this path.

```ts
{
  services: [{
    name: string; description: string; method: "GET";
    url: string;             // ".../risk/{invoiceId}/report"
    freePreview: string;     // ".../risk/{invoiceId}/summary"
    listings: string;        // ".../invoices"
    scheme: "exact"; facilitator: string;
    price: 1; payerTotal: 1.01; currency: "uINR"; token: string; decimals: 2;
    amountBaseUnits: 100; payerFeePct: 1; payTo: string; network: string;
  }];
  hashscanUrl: string;
  links: Link[];
}
```

### How the score works

Points out of 100, based on the buyer unless noted:

| Category | Max | Inputs | No data |
| --- | ---: | --- | --- |
| Payment history | 40 | On-time share (up to 28) and average days late (up to 12, reaching 0 at 60 days). Fewer than 5 invoices are pulled toward neutral | 20, low confidence |
| Company profile | 25 | Age (up to 10), GST filing rate (up to 10), size (up to 5) | 9 |
| This invoice | 20 | Amount against the buyer's usual (up to 8) and the supplier's usual (up to 8), and days to due (up to 4). "Usual" is the median of at least 3 settled invoices | 5 for each amount |
| Network | 15 | How promptly the buyer pays its other suppliers. Fewer than 3 suppliers are pulled toward neutral | 7.5 |

| Score | Grade | Rate a year |
| --- | --- | ---: |
| 80 or more | A | 12% |
| 65–79 | B | 16% |
| 50–64 | C | 20% |
| Under 50 | D | Not listed |

The rate becomes a discount based on days to the due date. See [POST /invoices/:id/tokenize](#post-invoicesidtokenize).

- **Fraud:** any flag means grade D, and the score is capped at 49. The checks are billing loops, a director shared by supplier and buyer, and a shared address. They run behind a small `GraphStore` interface in `backend/src/risk/graphStore.ts`, so Neo4j can replace the in-memory version.
- **Anomaly:** an amount over 10× the supplier's usual raises a warning and takes off 10 points. It doesn't force grade D by itself.
- **Confidence:** low if either company isn't in the dataset or the buyer has under 5 settled invoices. Medium with 5–19, or when the supplier has too little history. High otherwise.

### The fraud demo invoice

`GET /invoices` includes one simulated invoice so the marketplace can show a blocked fraud case:

```ts
{ id: "DEMO-RING"; seeded: true; status: "risk_checked"; grade: "D"; /* no tokenId */ }
```

Show it as a blocked card with no Buy button. The existing listing filter hides it, because it has no token, so the frontend has to add it separately. Its `supplierId` and `buyerId` are dataset company IDs, not Hedera accounts.

It's read-only:

| Route | Result |
| --- | --- |
| `GET /invoices/DEMO-RING`, `GET /risk/DEMO-RING/summary` | Work |
| `GET /risk/DEMO-RING/report`, `POST /risk/DEMO-RING/buy-report` | Work, for ₹1.00 like any other report |
| `POST /invoices/DEMO-RING/tokenize` | `409 RISK_BLOCKED`, with the reasons |
| Any other write route, and `GET /invoices/DEMO-RING/holders` | `409 SEEDED_INVOICE` |

If the risk engine is down, `GET /invoices` still returns real invoices and leaves this one out.

## Agent

The auto-invest agent applies the investor's rules with no person involved after the run starts. The rules are enforced in plain code (`backend/src/agent/rules.ts`), with no LLM anywhere in the decision.

### POST /agent/run

**Investor token required.** Runs one pass over the listings and returns the receipt. It usually takes 1–2 minutes, so show a loading state and don't set a short client timeout.

**Request** (all required; any other field returns `400`)

```ts
{
  reportBudget: number;        // Rupees for this run, including the 1% fee. At most 50
  investmentBudget: number;    // Rupees for this run, including the 1% fee. At most 50,000
  minGrade: "A" | "B" | "C";
  maxUnitsPerInvoice: number;  // The investor's total position in one invoice, counting units bought earlier
}
```

**What it does for each invoice**

1. **Finds the service:** it reads `GET /.well-known/x402`, then `GET /invoices`.
2. **Skips without paying:** an invoice that has matured or sold out. Invoices that aren't tokenized, funded or simulated aren't checked at all.
3. **Pays for the report** over x402. It first checks the quote: it must be in uINR, pay the risk agent, cost at most ₹2, and fit the budget left.
4. **Decides,** in this order:

| Check | Skip code |
| --- | --- |
| Any fraud flag | `FRAUD` |
| An anomaly warning, whatever the minimum grade | `ANOMALY` |
| Grade below the minimum, including any grade D | `BELOW_MIN_GRADE` |
| No token to buy | `NOT_BUYABLE` |
| Already holds `maxUnitsPerInvoice` | `MAX_UNITS_REACHED` |
| The budget left doesn't cover one unit and its fee | `INVESTMENT_BUDGET_EXHAUSTED` |

5. **Buys** as many units as the unit limit, the units available and the budget allow.

Skips can also carry `QUOTE_NOT_ALLOWED`, `REPORT_BUDGET_EXHAUSTED`, or an error code from the report or buy route.

**It stops the whole run** if the HCS audit log fails, the investor can't cover a report, the service names an account or token that isn't allowed, or a payment may have gone through without an answer. A payment that may have gone through still counts against the budget.

**Response `201`**

```ts
interface AgentRun {
  runId: string;
  status: "running" | "completed" | "stopped" | "interrupted";
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  investor: string;
  rules: AgentRules;
  endpoint?: string;            // The paid endpoint it found
  invoicesChecked: string[];
  reports: {
    invoiceId: string;
    amount: number;             // 1
    feeToPool: number;          // 0.01
    transactionId: string;
    hashscanUrl: string;
    grade: string;
    riskScore: number;
    fraudFlags: string[];
    anomaly: boolean;
  }[];
  spentOnReports: number;       // Rupees, including the fee
  purchases: {
    invoiceId: string;
    units: number;
    unitPrice: number;
    amount: number;
    feeToPool: number;
    paymentHashscanUrl?: string;
    unitsHashscanUrl?: string;
  }[];
  spentOnUnits: number;         // Rupees, including the fee
  skipped: { invoiceId: string; code: string; reason: string; paidForReport: boolean }[];
  auditTopicId?: string;
  auditMessages: { type: string; hashscanUrl: string; txId?: string }[];
  hashscanUrl: string;          // The HCS audit topic
  links: Link[];
}
```

A stopped run still returns `201` with its receipt, so check `status`.

**Errors**

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | A rule is missing, unknown or over its maximum. Doesn't start a run |
| 401 | `INVESTOR_TOKEN_REQUIRED`, `INVESTOR_TOKEN_INVALID`, `INVESTOR_TOKEN_EXPIRED` | Get a new session |
| 409 | `AGENT_RUN_IN_PROGRESS` | Only one run at a time |
| 429 | `RATE_LIMITED` | 5 requests in 10 minutes from this IP |
| 429 | `AGENT_DAILY_CAP_REACHED` | 20 runs a UTC day, across all callers. Adds `cap` and `resetsAt`. Kept in the store, so a restart doesn't reset it |

**The audit log:** every run writes `run.started`, `report.paid`, `decision`, `purchase` and `run.completed` messages to HCS topic [`0.0.11332556`](https://hashscan.io/testnet/topic/0.0.11332556). Only the investor's key can write to it, and the topic has no admin key, so nobody can change or delete a message.

### GET /agent/runs

Past receipts, newest first. It's open, like the other reads.

```ts
{ runs: AgentRun[]; hashscanUrl: string; links: Link[] }
```

A run cut off by a server restart shows `status: "interrupted"`, with what it spent up to that point.

## KYC

### POST /kyc

**Request**

```ts
{ fullName: string; walletAddress: string; country: string }
```

**Response `201`**

```ts
{ request: KycRequest; created: boolean; hashscanUrl: string; links: Link[] }
```

If this wallet already has a request, it returns that one with `created: false`. Personal details stay off-chain.

**Errors:** `422 WALLET_NOT_FOUND`

### POST /kyc/:id/approve

**Admin token required.** Approves the request and adds the wallet to every live bond's allowlist. No request body.

**Response `200`**

```ts
{
  request: KycRequest;
  results: {
    invoiceId: string; symbol: string; tokenId: string;
    ok: boolean; alreadyListed?: boolean; reason?: string;
    hashscanUrl: string; txId?: string;
  }[];
  links: Link[];
  tx: TxResult;
  hashscanUrl: string;
}
```

A paused bond can't change its allowlist. It appears in `results` with `ok: false`, the bond ID goes into `pendingBonds`, and the wallet is added automatically on unpause. If there are no live bonds, `tx.txId` is empty and the links point to the wallet.

**Errors:** `409 KYC_REJECTED`, `409 WALLET_FLAGGED`

### POST /kyc/:id/reject

**Admin token required.** Marks the request as rejected. No request body, and nothing goes on-chain, so `tx.txId` is empty and the links point to the wallet. Rejecting it again returns the same result. The wallet can submit a new request later.

**Response `200`**

```ts
{ request: KycRequest; links: Link[]; tx: TxResult; hashscanUrl: string }
```

**Errors:** `409 KYC_ALREADY_APPROVED` (rejecting wouldn't remove the wallet from bond allowlists, so it's refused)

### GET /kyc

Optional query: `?walletAddress=0.0.x`

```ts
{ requests: KycRequest[]; hashscanUrl: string; links: Link[] }
```

## Token controls

`:id` is the bond's contract ID (`invoice.tokenId`) or its symbol.

### POST /tokens/:id/pause and /unpause

**Admin token required.** No request body. Pausing blocks transfers, purchases, minting, allowlist changes, freezes and redemption.

**Response `200`**

```ts
{ tokenId: string; paused: boolean; tx: TxResult; links: Link[]; hashscanUrl: string; allowlistRetries?: object[] }
```

`allowlistRetries` appears on unpause only, and lists wallets added that had been waiting.

**Errors:** `409 ALREADY_PAUSED`, `409 NOT_PAUSED`

### POST /tokens/:id/freeze and /unfreeze

**Admin token required.**

**Request**

```ts
{
  accountId: string;
  units?: number;  // Freeze: defaults to all free units. Unfreeze: defaults to all frozen units
}
```

**Response `200`**

```ts
{ tokenId: string; accountId: string; frozen: boolean; frozenUnits: number; freeUnits: number; tx: TxResult; links: Link[]; hashscanUrl: string }
```

A frozen holder stays on the allowlist. Repayment is refused while any units are frozen.

**Errors:** `409 INSUFFICIENT_UNITS`, `409 NOTHING_TO_FREEZE`, `409 NOTHING_TO_UNFREEZE`, `409 BOND_PAUSED`, `422 ACCOUNT_NOT_FOUND`

### GET /tokens

Matches the frontend's `TokenInfo`, with `symbol` and `hashscanUrl` added.

```ts
{
  tokens: {
    tokenId: string; symbol: string; invoiceId: string; buyerName: string;
    totalUnits: number; unitFaceValue: number; maturityDate: string;
    paused: boolean; holders: Holder[]; hashscanUrl: string;
  }[];
  hashscanUrl: string;
  links: Link[];
}
```

## Other reads

### GET /balances

HBAR, uINR and bond units for every server account and KYC wallet. `bonds` covers live bonds only.

```ts
{
  accounts: {
    accountId: string; name: string; role: string;
    hbar: number; uinr: number;
    bonds: { invoiceId: string; symbol: string; tokenId: string; units: number; frozenUnits: number; hashscanUrl: string }[];
    hashscanUrl: string;
  }[];
  uinrTokenId: string;
  hashscanUrl: string;
  links: Link[];
}
```

### GET /audit

Newest first. Includes rejected actions.

```ts
{ entries: AuditEntry[]; hashscanUrl: string; links: Link[] }
```

### GET /health

```ts
{ status: "ok"; network: "testnet"; hashscanUrl: string; links: Link[] }
```

## Mapping from `web/lib/api.ts`

| Mock function | Route | Notes |
| --- | --- | --- |
| `uploadInvoice` | `POST /invoices` | Send `buyerId` as the company's `hederaAccount`, and add `invoiceNumber`. Map `409 DUPLICATE_INVOICE` to `DuplicateInvoiceError` |
| `confirmInvoice` | `POST /invoices/:id/confirm` | |
| `createToken` | `POST /invoices/:id/tokenize` | Admin token. Send `maturityMinutes` for demos |
| `submitKyc` | `POST /kyc` | |
| `loginDemoAdmin` | `POST /auth/demo-admin` | Keep `token` and send it on every admin route |
| `reviewKyc(id, true)` | `POST /kyc/:id/approve` | Admin token |
| `reviewKyc(id, false)` | `POST /kyc/:id/reject` | Admin token |
| `getKycRequests`, `getMyKyc` | `GET /kyc` | |
| `buyUnits` | `POST /invoices/:id/buy` | Investor token. Generate one `idempotencyKey` per click |
| `paySupplierWithUnits` | `POST /invoices/:id/pay-supplier` | Send `supplierId` as the `hederaAccount` |
| `payInvoice` | `POST /invoices/:id/repay` | Handle `409 NOT_MATURED` |
| `buyRiskReport` | `POST /risk/:invoiceId/buy-report` | Investor token. Use `settlement.transactionId` for `paymentTx` |
| `getListings`, `getListing` (grade) | `GET /risk/:invoiceId/summary` | Add `DEMO-RING` as a blocked card |
| `getTokens` | `GET /tokens` | |
| `setTokenPaused` | `POST /tokens/:id/pause` or `/unpause` | Admin token |
| `setHolderFrozen` | `POST /tokens/:id/freeze` or `/unfreeze` | Admin token. `units` is optional |
| `getAuditLog` | `GET /audit` | Read `.entries` |
| `getInvoice`, `getBusinessInvoices`, `getBuyerToConfirm`, `getBuyerUpcoming`, `getAwaitingTokenization` | `GET /invoices`, `GET /invoices/:id` | Filter in the frontend |
| `getListings`, `getListing`, `getPortfolio`, `getBusinessSummary`, `getTransferableInvoices` | `GET /invoices`, `GET /invoices/:id/holders` | Derive in the frontend |

**No route yet:** `rejectInvoice`, `getCompanies`, `getSuppliers` and `isReportUnlocked`. These stay on mock data for now.
