# Deploying Udhaar: backend on Railway, web on Vercel

The backend is an Express server that holds the Hedera role keys and writes a JSON store. The web app is a Next.js app that only talks to the backend over HTTP. Deploy the backend first, because the web build needs its URL.

Everything here is on Hedera **testnet**. The keys are testnet keys, but treat them as secrets anyway.

## Before you start

- The repo must be on GitHub and both services must be able to read it.
- Have your `.env` open for copying values. Never commit it, and never paste a key into a chat, an issue or a log.
- **Run only one backend with the watchers on.** See [Watchers](#watchers-only-one-backend-with-them-on).

## 1. Backend on Railway

1. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
2. Open the service → **Settings → Source → Root Directory** and set `backend`. Railway then reads `backend/railway.json`:
   - build: `npm ci --include=dev` (the server runs through `tsx`, a dev dependency, so dev packages must be installed)
   - start: `npm start`
   - health check: `GET /health` (60 s timeout), restart on failure
3. **Add a volume** (service → right-click or **Settings → Volumes**) and mount it at `/data`. The store (`store.json`) lives there, so it survives redeploys.
4. Open **Variables** and add the variables below. Set `DATA_DIR=/data/` (the volume's mount path, with a trailing slash).
5. **Settings → Networking → Generate Domain.** Note the URL, for example `https://udhaar-api.up.railway.app`.
6. Deploy. The log should show `Fresh data directory: copied the seed store into /data/` on the first start, then `Udhaar API listening on 0.0.0.0:<port>`.

### Backend variables

Names only. Copy the values from your `.env`.

**Required: Hedera accounts** (one ID and one private key per role, plus the EVM address where your `.env` has one)

| Variable | Meaning |
| --- | --- |
| `ADMIN_ID`, `ADMIN_KEY` | Operator: deploys bonds, approves KYC |
| `BUSINESS_ID`, `BUSINESS_KEY`, `BUSINESS_EVM` | The supplier |
| `BUYER_ID`, `BUYER_KEY`, `BUYER_EVM` | BigBuild |
| `APEX_ID`, `APEX_KEY`, `APEX_EVM` | Apex Infra |
| `NOVA_ID`, `NOVA_KEY`, `NOVA_EVM` | Nova Retail |
| `INVESTOR_ID`, `INVESTOR_KEY`, `INVESTOR_EVM` | The investor persona and the agent |
| `RISK_AGENT_ID`, `RISK_AGENT_KEY`, `RISK_AGENT_EVM` | Receives x402 report payments |
| `POOL_ID`, `POOL_KEY`, `POOL_EVM` | Investor protection pool |
| `REPAYMENT_ID`, `REPAYMENT_KEY`, `REPAYMENT_EVM` | Pays holders at repayment |

**Required: app secrets**

| Variable | Meaning |
| --- | --- |
| `DEMO_ADMIN_PASSCODE` | Admin login. Without it admin routes stay locked |
| `MOCK_IRP_PRIVATE_KEY` | Signs the mock e-invoice QR |

**Required: deployment**

| Variable | Value |
| --- | --- |
| `DATA_DIR` | `/data/` (the volume's mount path) |
| `FRONTEND_ORIGIN` | The Vercel URL, for example `https://udhaar.vercel.app`. Comma-separated for several (no path, no trailing slash). Browsers from any other origin are refused. If unset, only `http://localhost:3000` is allowed |
| `TRUST_PROXY` | `1`, because Railway puts one proxy in front. Without it every user shares one rate limit |
| `SELF_URL` | The backend's own public URL, so the agent can reach its paywall. Defaults to `http://127.0.0.1:PORT`, which also works on Railway |

`PORT` is set by Railway. The server reads it and binds `0.0.0.0`.

**Optional**

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCHEDULE_WATCHER` | on | `off` stops the server creating and following repayment schedules |
| `SCHEDULE_CHECK_SECONDS` | `30` | How often the schedule check runs |
| `NAV_SCHEDULER` | on | `off` stops the daily NAV publish. `POST /nav/publish` still works |
| `DEMO_SHORT_MATURITY_MINUTES` | off | 3 to 1440. Shows the "Demo: short maturity" option to the admin |
| `DEMO_ADMIN_TOKEN_MINUTES` | `30` | Admin session length |
| `DEMO_INVESTOR_TOKEN_MINUTES` | `30` | Investor session length |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | x402 facilitator |
| `AGENT_DAILY_RUN_CAP` | `20` | Agent runs per UTC day |
| `AGENT_MAX_REPORT_BUDGET` | `50` | Highest `reportBudget`, in rupees |
| `AGENT_MAX_INVESTMENT_BUDGET` | `50000` | Highest `investmentBudget`, in rupees |
| `MAX_STEP_HBAR` | `15` | A single step that could cost more is refused |
| `UINR_TOKEN_ID` | from `deployments/uINR.json` | Only to point at a different uINR token |

Do not set `DATA_DIR` to a path with no volume behind it: the store would be lost on every deploy.

### The seed store

`backend/seed/store.json` is a snapshot of the demo store (invoices, KYC, purchases, ledger, audit, NAV history). It was checked to hold no private key, passcode or token: every Hedera key and passcode in `.env` was searched for in it, and the 64-character hex strings in it are invoice fingerprints, signatures and contract call results. It holds public account IDs and transaction IDs only.

On start, if `DATA_DIR` has no `store.json`, the seed is copied in. A store that already exists is never overwritten, so redeploying does not reset anything. To go back to the seed, delete `store.json` from the volume and restart. To refresh the seed, copy a new `store.json` over `backend/seed/store.json` and check it for secrets again.

The committed files the server also needs (`backend/deployments/*`, `backend/data/risk/*`) ship with the repo.

### Watchers: only one backend with them on

Two jobs run by themselves inside the server:

- **The schedule watcher** creates repayment schedules and runs repayment once a schedule has executed. Set `SCHEDULE_WATCHER=off` to stop it.
- **The NAV scheduler** publishes the daily NAV to the HCS topic. Set `NAV_SCHEDULER=off` to stop it.

Both write to Hedera and to the store. **If two backends share the same accounts, turn both off on all but one**, such as your laptop while Railway runs, or a second Railway environment. Otherwise they can both create a schedule for the same bond or publish NAV twice. Local test servers should run with both off. The start-up log prints whether each is on.

## 2. Web on Vercel

1. In Vercel: **Add New → Project**, import the same repo.
2. Set **Root Directory** to `web`. Framework preset: Next.js. Leave the build command as `npm run build` and the output as default.
3. Add these **Environment Variables** (Production, and Preview if you use previews):

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | The Railway URL, for example `https://udhaar-api.up.railway.app` (no trailing slash) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Your WalletConnect Cloud project ID. Without it the wallet connection is unavailable; the rest of the app is unaffected |

   Leave `NEXT_PUBLIC_USE_MOCK` unset. If it is `true` the app shows built-in sample data instead of calling the backend.
4. Deploy, then copy the production URL.
5. **Go back to Railway** and set `FRONTEND_ORIGIN` to that URL, then redeploy the backend. Until you do, the browser blocks every call.
6. If you use a custom domain or a preview URL, add it to `FRONTEND_ORIGIN` too, comma-separated. `NEXT_PUBLIC_*` values are baked in at build time, so after changing one, redeploy the web app.

In the WalletConnect Cloud project, add the Vercel domain to the allowed domains.

Checked: the web app builds with root `web/` and both variables set (`next build --webpack`, 10 routes, no errors).

## 3. Post-deploy checklist

- [ ] `GET <railway-url>/health` returns `{"status":"ok","network":"testnet",...}`.
- [ ] The Railway log shows the seed copied on the first start, and `Watchers: schedule on, NAV on` on exactly one backend.
- [ ] `GET <railway-url>/invoices` lists the demo invoices.
- [ ] The Vercel site loads and the portals show data, with no CORS error in the browser console. If there is one, check `FRONTEND_ORIGIN` for typos, a trailing path or `http` instead of `https`.
- [ ] Admin login with `DEMO_ADMIN_PASSCODE` works (a wrong passcode gives 401, no passcode set gives 503).
- [ ] `GET /balances` shows HBAR on every role. REPAYMENT needs about 1 HBAR per payout, and the buyer needs enough uINR for the invoice you will repay.
- [ ] Redeploy once and confirm the invoices are still there (this proves the volume is mounted at `DATA_DIR`).
- [ ] Rate limiting is per user: open the site from two networks, or check the logs for `ERR_ERL_FORWARDED_HEADER`, which means `TRUST_PROXY` is missing.
- [ ] Wallet button: connects, if `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set.
- [ ] Update the README's "Live app" line with the Vercel URL.
- [ ] Do not run `npm run demo:reset` against the live volume unless you mean to: it archives every invoice.
