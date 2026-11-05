# Udhaar API

The backend service for the Udhaar frontend. It runs on Hedera testnet, and all data is simulated.

- **Base URL:** `http://localhost:4000` by default (`PORT` changes it)
- **Start it:** `cd backend && npm start`
- **Format:** JSON requests and responses

## Before you switch from mock data

- **No authentication.** Anyone who can reach the server can trigger actions, signed with the server's keys. Don't expose it beyond a testnet demo.
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

Input errors that never reach the chain have no HashScan link: `400 VALIDATION_ERROR`, `400 INVALID_JSON`, `404 ROUTE_NOT_FOUND`, `404 INVOICE_NOT_FOUND`, `404 KYC_NOT_FOUND`, `404 TOKEN_NOT_FOUND` and `422 NO_SIGNING_KEY`.

**`502 CHAIN_OPERATION_FAILED`** can be returned by any write route if a chain step fails. Retrying is safe, because finished steps are not repeated.

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
  discountPct?: number;
  unitPrice?: number;         // Discounted price per unit
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

- `status` skips `risk_checked` for now, because the risk engine isn't built. `grade` and `riskScore` are never set, rather than filled with invented values.
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
  type: "invoice_upload" | "duplicate_rejected" | "buyer_confirm" | "buyer_payment" | "kyc_submit" | "kyc_approve"
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

The types `duplicate_rejected`, `kyc_submit`, `transfer_rejected`, `units_burn` and `holder_payout` aren't in the frontend's `TransactionType` yet.

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

Deploys the bond, allowlists the business and all KYC-approved wallets, and issues every unit to the business. Costs about 10.5 test HBAR. A retry resumes the same bond rather than deploying another.

**Request** (all optional)

```ts
{
  maturityMinutes?: number;  // Minutes from now, for demos. Wins over maturityDate
  maturityDate?: string;     // ISO. Defaults to the invoice's dueDate
  unitFaceValue?: number;    // Default 1000. Must divide the amount exactly
  discountPct?: number;      // Default 4. From 0 up to, but not including, 100
}
```

Maturity must be at least a minute away. An earlier time is moved to one minute out.

**Response `201`**

```ts
{ invoice: Invoice; links: Link[]; tx: TxResult; hashscanUrl: string; replayed: boolean }
```

`invoice.status` becomes `tokenized`.

**Errors:** `409 BAD_STATUS`, `422 BAD_MATURITY`, `422 BAD_FACE_VALUE`, `402 APPROVAL_REQUIRED` (the gas price pushed the deploy above the `MAX_STEP_HBAR` limit)

### POST /invoices/:id/buy

The investor pays the discounted price in uINR to the business, plus a 1% fee on top to POOL. The business then transfers the units. The server checks that the transfer would succeed before any money moves.

**Request**

```ts
{
  units: number;            // Positive whole number
  investorId?: string;      // Defaults to INVESTOR_ID
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

### GET /invoices/:id

```ts
{ invoice: Invoice; hashscanUrl: string; links: Link[] }
```

### GET /invoices/:id/holders

Current holders, read from the chain. Burned units no longer exist there, so after repayment `holders` is empty and `repaidHolders` shows who was paid.

```ts
{ invoiceId: string; tokenId: string | null; holders: Holder[]; repaidHolders: RepaymentHolder[]; hashscanUrl: string }
```

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

Approves the request and adds the wallet to every live bond's allowlist. No request body.

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

### GET /kyc

Optional query: `?walletAddress=0.0.x`

```ts
{ requests: KycRequest[]; hashscanUrl: string; links: Link[] }
```

## Token controls

`:id` is the bond's contract ID (`invoice.tokenId`) or its symbol.

### POST /tokens/:id/pause and /unpause

No request body. Pausing blocks transfers, purchases, minting, allowlist changes, freezes and redemption.

**Response `200`**

```ts
{ tokenId: string; paused: boolean; tx: TxResult; links: Link[]; hashscanUrl: string; allowlistRetries?: object[] }
```

`allowlistRetries` appears on unpause only, and lists wallets added that had been waiting.

**Errors:** `409 ALREADY_PAUSED`, `409 NOT_PAUSED`

### POST /tokens/:id/freeze and /unfreeze

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
| `createToken` | `POST /invoices/:id/tokenize` | Send `maturityMinutes` for demos |
| `submitKyc` | `POST /kyc` | |
| `reviewKyc(id, true)` | `POST /kyc/:id/approve` | |
| `getKycRequests`, `getMyKyc` | `GET /kyc` | |
| `buyUnits` | `POST /invoices/:id/buy` | Generate one `idempotencyKey` per click |
| `paySupplierWithUnits` | `POST /invoices/:id/pay-supplier` | Send `supplierId` as the `hederaAccount` |
| `payInvoice` | `POST /invoices/:id/repay` | Handle `409 NOT_MATURED` |
| `getTokens` | `GET /tokens` | |
| `setTokenPaused` | `POST /tokens/:id/pause` or `/unpause` | |
| `setHolderFrozen` | `POST /tokens/:id/freeze` or `/unfreeze` | `units` is optional |
| `getAuditLog` | `GET /audit` | Read `.entries` |
| `getInvoice`, `getBusinessInvoices`, `getBuyerToConfirm`, `getBuyerUpcoming`, `getAwaitingTokenization` | `GET /invoices`, `GET /invoices/:id` | Filter in the frontend |
| `getListings`, `getListing`, `getPortfolio`, `getBusinessSummary`, `getTransferableInvoices` | `GET /invoices`, `GET /invoices/:id/holders` | Derive in the frontend |

**No route yet:** `rejectInvoice`, `reviewKyc(id, false)`, `getCompanies`, `getSuppliers`, `buyRiskReport` and `isReportUnlocked`. These stay on mock data for now.
