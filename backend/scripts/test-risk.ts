/**
 * Tests the risk engine through a real server process: every planted story, the real invoices,
 * masking, failure handling and tokenize pricing.
 *
 * Spends no HBAR. MAX_STEP_HBAR is set so low that the bond deploy is refused before sending, which
 * happens after the price is saved, and the script checks that total balances didn't change.
 *
 * Usage: npm run test:risk
 * Works on a temporary copy of the store. The real store is only read.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discountedUnitPrice } from "../src/risk/scorecard.js";

const BACKEND = fileURLToPath(new URL("../", import.meta.url));
const SEED_DIR = `${BACKEND}data/risk/`;
const REAL_STORE = `${BACKEND}data/store.json`;
const DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-risk-"))}/`;
const STORE_PATH = `${DATA_DIR}store.json`;
process.env.DATA_DIR = DATA_DIR;

type Json = Record<string, any>;
const readSeed = (name: string) => JSON.parse(readFileSync(`${SEED_DIR}${name}.json`, "utf8")) as any;

const PORT = 4102;
const BASE = `http://localhost:${PORT}`;
const PASSCODE = randomBytes(16).toString("hex");

let passes = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function request(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json };
}
const code = (reply: { status: number; json: Json }) => `${reply.status} ${reply.json.error?.code ?? "ok"}`;

/**
 * The route charges for this, so the scoring tests call the scorer itself, on the store the server
 * saved. The route has no free path, and test-x402.ts tests it.
 */
async function reportOf(id: string): Promise<{ status: number; json: Json }> {
  const { riskReport } = await import("../src/risk/service.js");
  const { state } = await import("../src/store.js");
  const { ApiError } = await import("../src/errors.js");
  Object.assign(state, JSON.parse(readFileSync(STORE_PATH, "utf8")));
  try {
    return { status: 200, json: JSON.parse(JSON.stringify(await riskReport(id))) as Json };
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, json: { error: { code: error.code, message: error.message } } };
    throw error;
  }
}

async function withServer(env: Record<string, string>, run: () => Promise<void>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, DEMO_ADMIN_PASSCODE: PASSCODE, MAX_STEP_HBAR: "0.001", ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        up = (await fetch(`${BASE}/health`)).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!up) throw new Error("Server did not start");
    await run();
  } finally {
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    }
  }
}

const login = async () => (await request("POST", "/auth/demo-admin", { body: { passcode: PASSCODE } })).json.token as string;
const totalHbar = async () => ((await request("GET", "/balances")).json.accounts as Json[]).reduce((sum, account) => sum + Number(account.hbar), 0);

// ---- 1. The dataset itself.
function checkDataset() {
  const companies = readSeed("companies") as Json[];
  const directors = readSeed("directors") as Json[];
  const invoices = readSeed("invoices") as Json[];
  const manifest = readSeed("manifest");
  const { stories } = manifest;

  check("about 52 companies", companies.length === 52, String(companies.length));
  check("about 80 directors", directors.length === 80, String(directors.length));
  check("about 500 invoices", invoices.length === 500, String(invoices.length));
  check("every ID has GSTIN format", companies.every((company) => /^\d{2}[A-Z]{5}\d{4}[A-Z]1Z[0-9A-Z]$/.test(company.id)));

  const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const validChecksum = (gstin: string) => {
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const product = BASE36.indexOf(gstin.charAt(i)) * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(product / 36) + (product % 36);
    }
    return BASE36.charAt((36 - (sum % 36)) % 36) === gstin.charAt(14);
  };
  check("no ID passes the GSTIN checksum, so none can be real", companies.every((company) => !validChecksum(company.id)));

  const { micro, small, medium } = manifest.calibration.meanDebtorDays;
  check("micro firms wait more than double small firms", micro > 2 * small, `${micro} vs ${small}`);
  check("micro firms wait almost triple medium firms", micro / medium >= 2.4 && micro / medium < 3, `${micro} vs ${medium}`);
  check("discount rates stay within 6.5–9% a year", invoices.every((invoice) => invoice.discountRatePctPa >= 6.5 && invoice.discountRatePctPa <= 9));

  const settledBy = (buyer: string) => invoices.filter((invoice) => invoice.buyerId === buyer && invoice.status !== "open");
  const daysLate = (invoice: Json) => (Date.parse(invoice.paidDate) - Date.parse(invoice.dueDate)) / 86_400_000;

  const reliable = settledBy(stories.reliableBuyer.buyer);
  check("reliable buyer has about 30 invoices", reliable.length === 30, String(reliable.length));
  const onTime = reliable.filter((invoice) => daysLate(invoice) <= 0).length / reliable.length;
  check("reliable buyer pays about 95% on time", onTime >= 0.93 && onTime <= 0.98, String(onTime));

  const late = settledBy(stories.latePayer.buyer);
  const in20to40 = late.filter((invoice) => daysLate(invoice) >= 20 && daysLate(invoice) <= 40).length / late.length;
  check("late payer is usually 20–40 days late", in20to40 >= 0.75 && in20to40 < 1, String(in20to40));

  const newBuyer = companies.find((company) => company.id === stories.newBuyer.buyer);
  check("new buyer was founded last year", newBuyer?.foundedYear === 2025);
  check("new buyer has no payment history", settledBy(stories.newBuyer.buyer).length === 0);

  const [x, y, z] = stories.fraudRing.companies as string[];
  const bills = (from?: string, to?: string) => invoices.some((invoice) => invoice.supplierId === from && invoice.buyerId === to);
  check("ring: X bills Y, Y bills Z, Z bills X", bills(x, y) && bills(y, z) && bills(z, x));

  const owner = directors.find((director) => director.id === stories.hiddenOwner.director);
  check("hidden owner sits on both boards", stories.hiddenOwner.companies.every((id: string) => owner?.companyIds.includes(id)));

  const [addressA, addressB] = (stories.sharedAddress.companies as string[]).map((id) => companies.find((company) => company.id === id));
  check("shared address pair really share one", Boolean(addressA?.address) && addressA?.address === addressB?.address);

  const usual = invoices.filter((invoice) => invoice.supplierId === stories.amountAnomaly.supplier && invoice.status === "paid").map((invoice) => invoice.amount).sort((a, b) => a - b);
  const typical = usual[Math.floor(usual.length / 2)];
  check("anomaly supplier usually bills about ₹50k", typical >= 40_000 && typical <= 60_000, String(typical));
  check("anomaly invoice is ₹40 lakh", invoices.find((invoice) => invoice.id === stories.amountAnomaly.invoiceId)?.amount === 40_00_000);
}

async function checkReproducible() {
  // Regenerates into a temporary folder, so the committed data (and the buyer companies added on top of it) is never overwritten.
  const out = mkdtempSync(join(tmpdir(), "udhaar-regen-"));
  await new Promise<void>((resolve, reject) => {
    spawn(process.execPath, ["--import", "tsx", "scripts/generate-data.ts"], { cwd: BACKEND, stdio: "ignore", env: { ...process.env, RISK_OUTPUT_DIR: out } }).once("exit", (status) => (status === 0 ? resolve() : reject(new Error(`generator exited ${status}`))));
  });
  const read = (dir: string, name: string) => JSON.parse(readFileSync(`${dir}${dir.endsWith("/") ? "" : "/"}${name}.json`, "utf8"));
  const same = (name: string) => JSON.stringify(read(SEED_DIR, name)) === JSON.stringify(read(out, name));
  // add-buyer-companies puts 2 companies, 2 account links and a company count on top of the generated data.
  const generatedCompanies = read(out, "companies") as unknown[];
  const keptCompanies = (read(SEED_DIR, "companies") as unknown[]).slice(0, generatedCompanies.length);
  const links = read(SEED_DIR, "account-links") as Record<string, string>;
  const generatedLinks = read(out, "account-links") as Record<string, string>;
  const manifest = read(SEED_DIR, "manifest");
  const generatedManifest = read(out, "manifest");
  check("regenerating gives byte-identical directors and invoices", same("directors") && same("invoices"));
  check("regenerating gives the same first 50 companies", JSON.stringify(keptCompanies) === JSON.stringify(generatedCompanies));
  check("regenerating gives the same account links, which the buyer companies only add to", Object.entries(generatedLinks).every(([role, id]) => links[role] === id));
  check("regenerating gives the same manifest apart from the company count", JSON.stringify({ ...manifest, counts: { ...manifest.counts, companies: 0 } }) === JSON.stringify({ ...generatedManifest, counts: { ...generatedManifest.counts, companies: 0 } }));
}

// ---- 2. Scores for every story and every real invoice.
interface Expected {
  id: string;
  label: string;
  grade?: string[];
  flags?: string[];
  anomaly?: boolean;
  confidence?: string;
}
const rows: { label: string; report: Json }[] = [];

async function scoreStories(realIds: string[]) {
  const expected: Expected[] = [
    { id: "DEMO-RELIABLE", label: "Reliable buyer", grade: ["A"], flags: [], anomaly: false, confidence: "HIGH" },
    { id: "DEMO-LATE", label: "Late payer", grade: ["C"], flags: [], anomaly: false },
    { id: "DEMO-NEW", label: "New buyer", grade: ["C"], flags: [], anomaly: false, confidence: "LOW" },
    { id: "DEMO-RING", label: "Fraud ring", grade: ["D"], flags: ["CIRCULAR_INVOICING"] },
    { id: "DEMO-HIDDEN", label: "Hidden owner", grade: ["D"], flags: ["SHARED_DIRECTOR"] },
    { id: "DEMO-ADDRESS", label: "Shared address", grade: ["D"], flags: ["SHARED_ADDRESS"] },
    { id: "DEMO-ANOMALY", label: "Amount anomaly", flags: [], anomaly: true },
  ];
  for (const story of expected) {
    const { status, json } = await reportOf(story.id);
    check(`${story.id} returns a report`, status === 200, String(status));
    rows.push({ label: `${story.id} (${story.label})`, report: json });
    if (story.grade) check(`${story.id} grade`, story.grade.includes(json.grade), `${json.grade} (score ${json.riskScore})`);
    if (story.flags) check(`${story.id} flags`, JSON.stringify(json.fraudFlags) === JSON.stringify(story.flags), JSON.stringify(json.fraudFlags));
    if (story.anomaly !== undefined) check(`${story.id} anomaly`, json.anomaly === story.anomaly, String(json.anomaly));
    if (story.confidence) check(`${story.id} confidence`, json.confidence === story.confidence, json.confidence);
    check(`${story.id} has reasons`, Array.isArray(json.reasons) && json.reasons.length >= 3);
    const points = json.breakdown;
    const total = points.paymentHistory.points + points.companyProfile.points + points.thisInvoice.points + points.network.points - points.anomalyPenalty;
    check(`${story.id} points add up`, Math.abs(Math.round(total) - points.scoreBeforeFraudCap) <= 1, `${total} vs ${points.scoreBeforeFraudCap}`);
    check(`${story.id} categories stay within their maximums`, points.paymentHistory.points <= 40 && points.companyProfile.points <= 25 && points.thisInvoice.points <= 20 && points.network.points <= 15);
  }

  const anomaly = rows.find((row) => row.label.startsWith("DEMO-ANOMALY"))?.report;
  check("anomaly takes points off", anomaly?.breakdown.anomalyPenalty > 0);
  check("anomaly raises a warning", anomaly?.reasons.some((reason: string) => reason.startsWith("Warning:")));

  for (const id of realIds) {
    const { status, json } = await reportOf(id);
    check(`${id} returns a report`, status === 200, code({ status, json }));
    const kind = id.startsWith("TEST-") ? "not in dataset" : "real";
    rows.push({ label: `${id} (${kind}, ₹${Number(json.amount).toLocaleString("en-IN")})`, report: json });
  }
}

// ---- 3. Every invoice in the dataset, to catch false alarms.
async function checkFalsePositives() {
  const invoices = readSeed("invoices") as Json[];
  const { stories } = readSeed("manifest");
  const companyPairs = new Set<string>();
  const [x, y, z] = stories.fraudRing.companies as string[];
  for (const [a, b] of [[x, y], [y, z], [z, x]]) companyPairs.add(`${a}>${b}`);
  companyPairs.add(`${stories.hiddenOwner.companies[0]}>${stories.hiddenOwner.companies[1]}`);
  companyPairs.add(`${stories.sharedAddress.companies[0]}>${stories.sharedAddress.companies[1]}`);

  const grades: Record<string, number> = {};
  let wrongFlags = 0;
  let missedFlags = 0;
  let anomalies = 0;
  for (const invoice of invoices) {
    const { status, json } = await reportOf(invoice.id);
    if (status !== 200) throw new Error(`${invoice.id} returned ${status}`);
    grades[json.grade] = (grades[json.grade] ?? 0) + 1;
    const planted = companyPairs.has(`${invoice.supplierId}>${invoice.buyerId}`);
    if (planted && json.fraudFlags.length === 0) missedFlags++;
    if (!planted && json.fraudFlags.length > 0) wrongFlags++;
    if (json.anomaly) anomalies++;
    if (json.fraudFlags.length > 0 && json.grade !== "D") check(`${invoice.id}: any fraud flag means grade D`, false, json.grade);
    const rate = { A: 12, B: 16, C: 20, D: null }[json.grade as "A" | "B" | "C" | "D"];
    const days = Math.ceil((Date.parse(invoice.dueDate) - Date.parse(json.scoredAt)) / 86_400_000);
    if (json.annualRatePct !== rate || json.daysToDue !== days) check(`${invoice.id}: rate and days to due`, false, `${json.annualRatePct}, ${json.daysToDue}`);
    if (rate === null || days <= 0) {
      if (json.suggestedDiscountPct !== null) check(`${invoice.id}: no discount for grade D or past due`, false, String(json.suggestedDiscountPct));
    } else if (Math.abs(json.suggestedDiscountPct - (rate * days) / 365) >= 0.0001) {
      check(`${invoice.id}: discount is rate × days / 365`, false, String(json.suggestedDiscountPct));
    }
    if (json.grade === "A" && json.riskScore < 80) check(`${invoice.id}: A needs 80`, false);
    if (json.grade === "D" && json.riskScore >= 50) check(`${invoice.id}: D needs under 50`, false);
  }
  check("no invoice outside a planted pair is flagged as fraud", wrongFlags === 0, String(wrongFlags));
  check("every invoice inside a planted pair is flagged", missedFlags === 0, String(missedFlags));
  check("the only anomaly in the dataset is the planted one", anomalies === 1, String(anomalies));
  console.log(`All ${invoices.length} dataset invoices scored. Grades: ${Object.entries(grades).sort().map(([grade, count]) => `${grade} ${count}`).join(", ")}. Fraud false alarms: ${wrongFlags}.`);
}

// ---- 4. What each route exposes.
async function checkExposure() {
  const directors = readSeed("directors") as Json[];
  const companies = readSeed("companies") as Json[];

  for (const id of ["DEMO-RING", "DEMO-HIDDEN", "DEMO-ADDRESS", "DEMO-RELIABLE"]) {
    const summary = await request("GET", `/risk/${id}/summary`);
    check(`${id} summary has grade and confidence`, Boolean(summary.json.grade) && Boolean(summary.json.confidence));
    check(`${id} summary hides the paid fields`, ["riskScore", "reasons", "fraudFlags", "graph", "breakdown", "anomaly", "creditRisk"].every((field) => !(field in summary.json)));
    check(`${id} summary has a HashScan link`, String(summary.json.hashscanUrl).startsWith("https://hashscan.io/testnet/"));

    const report = await reportOf(id);
    const text = JSON.stringify(report.json);
    check(`${id} report names no director`, !directors.some((director) => text.includes(director.name)));
    check(`${id} report has no director IDs`, !directors.some((director) => text.includes(director.id)));
    const { supplier, buyer } = report.json;
    const parties = companies.filter((company) => company.name === supplier.name || company.name === buyer.name);
    check(`${id} report has no addresses or phones`, parties.every((company) => !text.includes(company.address) && !text.includes(company.phone)));
    const people = report.json.graph.nodes.filter((node: Json) => node.type === "person");
    check(`${id} graph masks every person`, people.length > 0 && people.every((node: Json) => /^Director [A-Z]$/.test(node.label)));
    check(`${id} graph is small`, report.json.graph.nodes.length <= 20, String(report.json.graph.nodes.length));
    const nodeIds = new Set(report.json.graph.nodes.map((node: Json) => node.id));
    check(`${id} graph links only known nodes`, report.json.graph.links.every((link: Json) => nodeIds.has(link.source) && nodeIds.has(link.target)));
  }

  const ring = await reportOf("DEMO-RING");
  check("ring graph shows all three companies", ring.json.graph.nodes.filter((node: Json) => node.type === "company" && node.flagged).length === 3);
  check("ring graph closes the loop", ring.json.graph.links.filter((link: Json) => (link.type === "billed" || link.type === "invoice") && link.flagged).length === 3);
  const hidden = await reportOf("DEMO-HIDDEN");
  check("hidden owner is one flagged person linked to both", hidden.json.graph.links.filter((link: Json) => link.type === "director_of" && link.flagged).length === 2);
  const address = await reportOf("DEMO-ADDRESS");
  check("shared address node links to both", address.json.graph.links.filter((link: Json) => link.type === "registered_at").length === 2);

  const missing = await request("GET", "/risk/NOPE/summary");
  check("unknown invoice is a 404", code(missing) === "404 INVOICE_NOT_FOUND", code(missing));

  // The fraud demo card.
  const { json } = await request("GET", "/invoices");
  const demo = (json.invoices as Json[]).filter((invoice) => invoice.seeded);
  check("GET /invoices includes exactly one simulated invoice", demo.length === 1 && demo[0]?.id === "DEMO-RING", String(demo.length));
  check("its grade comes from the engine", demo[0]?.grade === "D");
  check("it has no token, so nothing can be bought", !demo[0]?.tokenId);
  check("no invoice in the list exposes a score", (json.invoices as Json[]).every((invoice) => !("riskScore" in invoice)));
  const single = await request("GET", "/invoices/DEMO-RING");
  check("GET /invoices/DEMO-RING works", single.status === 200 && single.json.invoice.seeded === true);
  const stored = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Json;
  check("the simulated invoice isn't written to the store", !stored.invoices["DEMO-RING"]);

  const token = await login();
  const blocked = await request("POST", "/invoices/DEMO-RING/tokenize", { body: {}, token });
  check("tokenizing the ring invoice is refused", code(blocked) === "409 RISK_BLOCKED" && blocked.json.error.fraudFlags.includes("CIRCULAR_INVOICING"), code(blocked));
  const session = await request("POST", "/auth/demo-investor");
  const buy = await request("POST", "/invoices/DEMO-RING/buy", { body: { units: 1 }, token: session.json.token });
  check("buying the ring invoice is refused", code(buy) === "409 SEEDED_INVOICE", code(buy));
  const audit = (await request("GET", "/audit")).json.entries as Json[];
  check("the refusal is in the audit log", audit.some((entry) => entry.type === "risk_blocked" && entry.invoiceId === "DEMO-RING" && entry.status === "rejected"));
}

// ---- 5. Tokenizing prices from the grade and the due date. The spending cap stops each deploy before it's sent.
// Tokenize allows 5 calls per 10 minutes per server, so these run in groups, with a restart between them.
type PricingIds = Record<"a" | "b" | "c" | "d" | "aDueDate" | "a30" | "aYear" | "pastDue" | "farOut" | "savedPlan" | "paise", string>;
const readStore = () => JSON.parse(readFileSync(STORE_PATH, "utf8")) as Json;

async function checkClientDiscountRefused(ids: PricingIds) {
  const token = await login();
  const rejected = await request("POST", `/invoices/${ids.a}/tokenize`, { body: { discountPct: 1 }, token });
  check("a discount sent by the client is rejected", code(rejected) === "400 VALIDATION_ERROR", code(rejected));
}

type PriceCase = [id: string, grade: string, days: number, discount: number, price: number, body: Json];

async function checkPriceCases(cases: PriceCase[]) {
  const token = await login();
  for (const [id, grade, days, discount, price, body] of cases) {
    const report = (await reportOf(id)).json;
    check(`${id} grades ${grade}`, report.grade === grade, report.grade);
    check(`${id} report shows the discount it will get`, report.suggestedDiscountPct === discount && report.daysToDue === days, `${report.suggestedDiscountPct}, ${report.daysToDue}`);
    const reply = await request("POST", `/invoices/${id}/tokenize`, { body, token });
    check(`${id} stopped by the spending cap`, reply.status === 402 || reply.status === 502, code(reply));
    const stored = readStore().invoices[id];
    check(`${id} saved a ${discount}% discount`, stored.tokenization?.discountPct === discount, String(stored.tokenization?.discountPct));
    check(`${id} unit price is ₹${price}`, discountedUnitPrice(stored.tokenization?.unitFaceValue, stored.tokenization?.discountPct) === price);
    check(`${id} saved its grade but no score`, stored.grade === grade && !("riskScore" in stored));
    check(`${id} deployed nothing`, !stored.tokenization?.bond);
  }
}

async function checkPriceRules(ids: PricingIds, legacyIds: string[]) {
  const token = await login();
  const dayAway = Date.now() / 1000 + 86_400;
  const short = readStore().invoices[ids.a].tokenization;
  const full = readStore().invoices[ids.aDueDate].tokenization;
  check("the demo bond really does mature early", short.maturityDateUnix < dayAway, String(short.maturityDateUnix));
  check("the ordinary bond matures on the due date", full.maturityDateUnix > dayAway, String(full.maturityDateUnix));
  check("a shortened maturity doesn't change the price", short.discountPct === full.discountPct);

  const report = (await reportOf(ids.a)).json;
  check("a priced invoice's report keeps the same days and discount", report.daysToDue === 75 && report.suggestedDiscountPct === 2.4658, `${report.daysToDue}, ${report.suggestedDiscountPct}`);

  // Prices already set must never move.
  const retry = await request("POST", `/invoices/${ids.savedPlan}/tokenize`, { body: { maturityMinutes: 5 }, token });
  check("a saved plan's retry is stopped by the spending cap", retry.status === 402 || retry.status === 502, code(retry));
  check("a retry keeps the saved plan's price", readStore().invoices[ids.savedPlan].tokenization.discountPct === 4);
  const listed = (await request("GET", "/invoices")).json.invoices as Json[];
  const real = listed.filter((invoice) => legacyIds.includes(invoice.id));
  check("every invoice tokenized before the risk engine is in the list", legacyIds.length > 0 && real.length === legacyIds.length, `${real.length} of ${legacyIds.length}`);
  check("invoices tokenized before the risk engine keep 4% and ₹960", real.every((invoice) => invoice.discountPct === 4 && invoice.unitPrice === 960), JSON.stringify(real.map((invoice) => [invoice.id, invoice.discountPct, invoice.unitPrice])));
  for (const id of legacyIds) {
    const realReport = (await reportOf(id)).json;
    check(`${id} report shows the 4% actually applied`, realReport.appliedDiscountPct === 4, String(realReport.appliedDiscountPct));
  }
  check("the listing shows paise", listed.find((invoice) => invoice.id === ids.paise)?.unitPrice === 970.41);
}

async function checkUnpriceable(ids: PricingIds) {
  const token = await login();
  for (const [id, label, days] of [[ids.pastDue, "past its due date", -5], [ids.farOut, "with a discount of 100% or more", 3285]] as const) {
    const refused = await request("POST", `/invoices/${id}/tokenize`, { body: { maturityMinutes: 5 }, token });
    check(`an invoice ${label} can't be priced, even with a demo maturity`, code(refused) === "422 BAD_DUE_DATE", code(refused));
    check(`${id} leaves no plan behind`, !readStore().invoices[id].tokenization);
    const unpriced = (await reportOf(id)).json;
    check(`${id} report suggests no discount`, unpriced.grade === "A" && unpriced.suggestedDiscountPct === null && unpriced.daysToDue === days, `${unpriced.grade}, ${unpriced.suggestedDiscountPct}, ${unpriced.daysToDue}`);
  }

  const blocked = await request("POST", `/invoices/${ids.d}/tokenize`, { body: {}, token });
  check("grade D is refused", code(blocked) === "409 RISK_BLOCKED", code(blocked));
  check("grade D leaves no plan behind", !readStore().invoices[ids.d].tokenization);
}

// ---- 6. Failures must never produce a score.
async function checkFailures(ids: { a: string; failPlan: string }) {
  const missingDir = `${DATA_DIR}nothing/`;
  await withServer({ RISK_DATA_DIR: missingDir }, async () => {
    const summary = await request("GET", "/risk/DEMO-RELIABLE/summary");
    check("missing data: summary is an error", code(summary) === "503 RISK_DATA_UNAVAILABLE" && !summary.json.grade, code(summary));
    const report = await request("GET", `/risk/${ids.a}/report`);
    check("missing data: report is an error", code(report) === "503 RISK_DATA_UNAVAILABLE" && !report.json.grade, code(report));
    const token = await login();
    const tokenize = await request("POST", `/invoices/${ids.failPlan}/tokenize`, { body: {}, token });
    check("missing data: tokenize is refused", code(tokenize) === "503 RISK_DATA_UNAVAILABLE", code(tokenize));
    const stored = (JSON.parse(readFileSync(STORE_PATH, "utf8")) as Json).invoices[ids.failPlan];
    check("missing data: no plan or price saved", !stored.tokenization && stored.discountPct === undefined);
    const list = await request("GET", "/invoices");
    check("missing data: real invoices still list", list.status === 200 && (list.json.invoices as Json[]).length > 0);
    check("missing data: the demo card is left out rather than guessed", !(list.json.invoices as Json[]).some((invoice) => invoice.seeded));
  });

  const corruptDir = `${DATA_DIR}corrupt/`;
  rmSync(corruptDir, { recursive: true, force: true });
  (await import("node:fs")).mkdirSync(corruptDir);
  for (const name of ["companies", "directors", "invoices", "account-links", "manifest"]) copyFileSync(`${SEED_DIR}${name}.json`, `${corruptDir}${name}.json`);
  writeFileSync(`${corruptDir}invoices.json`, "{ not json");
  await withServer({ RISK_DATA_DIR: corruptDir }, async () => {
    const reply = await request("GET", "/risk/DEMO-RELIABLE/summary");
    check("corrupt data: an error", code(reply) === "503 RISK_DATA_UNAVAILABLE", code(reply));
  });
  // Dropping one invoice changes the count, which the manifest catches.
  const short = (readSeed("invoices") as Json[]).slice(1);
  writeFileSync(`${corruptDir}invoices.json`, JSON.stringify(short));
  await withServer({ RISK_DATA_DIR: corruptDir }, async () => {
    const reply = await request("GET", "/risk/DEMO-RELIABLE/summary");
    check("data not matching its manifest: an error", code(reply) === "503 RISK_DATA_UNAVAILABLE", code(reply));
  });
  await withServer({ BUYER_ID: "", RISK_DATA_DIR: SEED_DIR }, async () => {
    const reply = await request("GET", "/risk/DEMO-RELIABLE/summary");
    check("unresolved account link: an error, not a new company", code(reply) === "503 RISK_DATA_UNAVAILABLE", code(reply));
  });

  // The graph is reached only through its interface, so a replacement works without other changes.
  const { assess } = await import("../src/risk/service.js");
  const { loadDataset } = await import("../src/risk/dataset.js");
  const dataset = loadDataset();
  const seeded = dataset.invoicesById.get("DEMO-RELIABLE");
  if (!seeded) throw new Error("DEMO-RELIABLE is missing");
  const subject = { id: seeded.id, seeded: true, supplierRef: seeded.supplierId, buyerRef: seeded.buyerId, supplierName: "S", buyerName: "B", amount: seeded.amount, dueDate: seeded.dueDate, scoredAt: Date.parse("2026-11-06T00:00:00Z"), hashscanUrl: "", links: [] };
  const clean = await assess(subject, dataset, dataset.graph);
  check("a clean invoice is not flagged by the in-memory store", clean.card.fraudFlags.length === 0 && clean.card.grade === "A");

  const replacement = {
    findCycles: async () => [[seeded.supplierId, seeded.buyerId, "0.0.5"]],
    findSharedDirectors: async () => [],
    findSharedAddress: async () => false,
    directorsOf: async () => [],
  };
  const flagged = await assess(subject, dataset, replacement);
  check("another GraphStore works without other changes", flagged.card.fraudFlags.includes("CIRCULAR_INVOICING") && flagged.card.grade === "D");

  const broken = { ...replacement, findCycles: async () => { throw new Error("graph down"); } };
  let threw = false;
  try {
    await assess(subject, dataset, broken);
  } catch {
    threw = true;
  }
  check("a failing GraphStore gives an error, not a score", threw);
}

function printTable() {
  console.log("\n| Invoice | Score | Grade | Confidence | Credit risk | Rate a year | Days to due | Discount | Applied | Fraud flags | Anomaly |");
  console.log("| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |");
  for (const { label, report } of rows) {
    console.log(`| ${label} | ${report.riskScore} | ${report.grade} | ${report.confidence} | ${report.creditRisk} | ${report.annualRatePct === null ? "Not listed" : `${report.annualRatePct}%`} | ${report.daysToDue} | ${report.suggestedDiscountPct === null ? "None" : `${report.suggestedDiscountPct}%`} | ${report.appliedDiscountPct === undefined ? "Not tokenized" : `${report.appliedDiscountPct}%`} | ${report.fraudFlags.join(", ") || "None"} | ${report.anomaly ? "Yes" : "No"} |`);
  }
  console.log("\nReasons:");
  for (const { label, report } of rows) {
    const b = report.breakdown;
    console.log(`\n${label}: history ${b.paymentHistory.points}/40, profile ${b.companyProfile.points}/25, invoice ${b.thisInvoice.points}/20, network ${b.network.points}/15${b.anomalyPenalty ? `, anomaly -${b.anomalyPenalty}` : ""}${report.fraudFlags.length ? `, ${b.scoreBeforeFraudCap} before the fraud cap` : ""}`);
    for (const reason of report.reasons) console.log(`  - ${reason}`);
  }
}

try {
  // A temporary store: the real invoices, plus test invoices for pricing.
  if (!existsSync(REAL_STORE)) throw new Error("backend/data/store.json is missing, so the real invoices can't be tested");
  copyFileSync(REAL_STORE, STORE_PATH);
  // demo:reset archives the real invoices to hide them from lists. This test needs them listed, so the copy un-archives them.
  const copied = JSON.parse(readFileSync(STORE_PATH, "utf8")) as { invoices: Record<string, { archived?: boolean }> };
  for (const invoice of Object.values(copied.invoices)) delete invoice.archived;
  writeFileSync(STORE_PATH, JSON.stringify(copied));
  const store = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Json;
  const realIds = Object.keys(store.invoices);
  const legacyIds = realIds.filter((id) => store.invoices[id].tokenId && !store.invoices[id].gradedAt);
  await import("../src/config.js");
  const business = process.env.BUSINESS_ID?.trim() ?? "";
  const buyer = process.env.BUYER_ID?.trim() ?? "";
  const manifest = readSeed("manifest");
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const makeInvoice = (id: string, supplierId: string, buyerId: string, amount: number, days = 75) => {
    store.invoices[id] = { id, supplierId, supplierName: "test supplier", buyerId, buyerName: "test buyer", amount, issueDate: new Date().toISOString(), dueDate: inDays(days), status: "buyer_confirmed", fingerprint: `sha256:${id}`, registered: true, links: [], amountPaidBy: {} };
  };
  const ids = { a: "TEST-A", aDueDate: "TEST-A-DUE", a30: "TEST-A30", aYear: "TEST-AYEAR", b: "TEST-B", c: "TEST-C", d: "TEST-D", pastDue: "TEST-PAST", farOut: "TEST-FAR", savedPlan: "TEST-PLAN", paise: "TEST-PAISE", failPlan: "TEST-FAIL", newBoth: "TEST-NEW" };
  makeInvoice(ids.a, business, buyer, 5_00_000);
  makeInvoice(ids.b, business, buyer, 2_00_00_000);
  makeInvoice(ids.c, business, "0.0.99999999", 5_00_000);
  const [ringX, ringY] = manifest.stories.fraudRing.companies as string[];
  makeInvoice(ids.d, ringX ?? "", ringY ?? "", 8_00_000);
  makeInvoice(ids.failPlan, business, buyer, 5_00_000);
  makeInvoice(ids.newBoth, "0.0.99999998", "0.0.99999999", 5_00_000);
  makeInvoice(ids.aDueDate, business, buyer, 5_00_000);
  makeInvoice(ids.a30, business, buyer, 5_00_000, 30);
  makeInvoice(ids.aYear, business, buyer, 5_00_000, 365);
  makeInvoice(ids.pastDue, business, buyer, 5_00_000, -5);
  makeInvoice(ids.farOut, business, buyer, 5_00_000, 3285);
  // A plan saved before this pricing, and a finished invoice with a price in paise.
  makeInvoice(ids.savedPlan, business, buyer, 5_00_000);
  store.invoices[ids.savedPlan].tokenization = { status: "in_progress", symbol: "UDH2611060000", isin: "US0000000000", name: "test plan", units: 500, unitFaceValue: 1000, discountPct: 4, startingDateUnix: Math.floor(Date.now() / 1000) + 60, maturityDateUnix: Math.floor(Date.now() / 1000) + 300 };
  makeInvoice(ids.paise, business, buyer, 5_00_000);
  Object.assign(store.invoices[ids.paise], { status: "tokenized", tokenId: "0.0.1", unitFaceValue: 1000, discountPct: 2.9589, totalUnits: 500, retainedUnits: 500 });
  writeFileSync(STORE_PATH, JSON.stringify(store));

  console.log("1. Dataset");
  checkDataset();
  await checkReproducible();

  let startHbar = 0;
  let endHbar = 0;
  console.log("2. Stories, real invoices and false alarms");
  await withServer({}, async () => {
    startHbar = await totalHbar();
    await scoreStories([...realIds, ids.newBoth]);
    await checkFalsePositives();
    const unknown = rows.find((row) => row.label.startsWith(ids.newBoth))?.report;
    check("a company not in the dataset scores as new, with low confidence", unknown?.confidence === "LOW" && unknown?.buyer.inDataset === false);
    console.log("3. Exposure and the fraud card");
    await checkExposure();
  });

  console.log("4. Tokenize pricing");
  // Worked out by hand: rate × days / 365, then ₹1,000 less that percentage, to the paisa.
  const priceCases: PriceCase[] = [
    [ids.a, "A", 75, 2.4658, 975.34, { maturityMinutes: 5 }],
    [ids.aDueDate, "A", 75, 2.4658, 975.34, {}],
    [ids.b, "B", 75, 3.2877, 967.12, { maturityMinutes: 5 }],
    [ids.c, "C", 75, 4.1096, 958.9, { maturityMinutes: 5 }],
    [ids.a30, "A", 30, 0.9863, 990.14, { maturityMinutes: 5 }],
    [ids.aYear, "A", 365, 12, 880, { maturityMinutes: 5 }],
  ];
  await withServer({}, async () => {
    await checkClientDiscountRefused(ids);
    await checkPriceCases(priceCases.slice(0, 3));
  });
  await withServer({}, async () => {
    await checkPriceCases(priceCases.slice(3));
    await checkPriceRules(ids, legacyIds);
  });
  await withServer({}, async () => {
    await checkUnpriceable(ids);
  });

  console.log("5. Failures");
  await checkFailures({ a: ids.a, failPlan: ids.failPlan });

  await withServer({}, async () => {
    endHbar = await totalHbar();
  });
  check("no HBAR spent", startHbar > 0 && startHbar === endHbar, `${startHbar} then ${endHbar}`);

  printTable();
  console.log(`\n${passes} passed, ${failures} failed. HBAR across all accounts: ${startHbar.toFixed(4)} before, ${endHbar.toFixed(4)} after.`);
} finally {
  rmSync(DATA_DIR, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
