/**
 * Extends the risk dataset with MOCK trust data: a GST registry and an external credit profile for
 * every company. It only reads companies.json, invoices.json, manifest.json and account-links.json,
 * and only writes gst-registry.json and external-profiles.json, so no company ID, invoice or grade
 * changes. Output is deterministic.
 *
 * EVERYTHING HERE IS FICTIONAL. GSTINs are checksum-valid but use the PAN serial 0000, which the
 * Income Tax Department is not known to issue, so none of them should belong to a real taxpayer.
 *
 * Usage: npm run generate-trust-data
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gstinCheckDigit } from "../src/trust/gstin.js";

const DIR = `${fileURLToPath(new URL("../", import.meta.url))}data/risk/`;
const read = (name: string) => JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8")) as any;
const companies = read("companies") as { id: string; name: string; type: string; size: string; foundedYear: number; gstFilingRate: number; city: string }[];
const invoices = read("invoices") as { id: string; supplierId: string; buyerId: string; dueDate: string; paidDate: string | null; status: string }[];
const manifest = read("manifest");
const links = read("account-links") as Record<string, string>;

const NOTICE = "MOCK DATA. Every GSTIN, registry record, score and complaint here is fictional. See docs/DATA.md.";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261106);
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const whole = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)] as T;

const STATE_BY_CITY: Record<string, [string, string]> = {
  Mumbai: ["27", "MH"], Pune: ["27", "MH"], Nagpur: ["27", "MH"], Nashik: ["27", "MH"], Bengaluru: ["29", "KA"], Chennai: ["33", "TN"], Coimbatore: ["33", "TN"],
  Hyderabad: ["36", "TS"], Ahmedabad: ["24", "GJ"], Surat: ["24", "GJ"], Delhi: ["07", "DL"], Kolkata: ["19", "WB"], Jaipur: ["08", "RJ"], Lucknow: ["09", "UP"],
  Indore: ["23", "MP"], Kochi: ["32", "KL"],
};
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const letter = () => pick(LETTERS);

const used = new Set<string>();
function mockGstin(name: string, city: string, size: string) {
  const [stateCode] = STATE_BY_CITY[city] ?? ["27", "MH"];
  for (;;) {
    // PAN: 3 letters, holder type (C company, F firm), first letter of the name, serial 0000 (not issued), a letter.
    const pan = `${letter()}${letter()}${letter()}${size === "micro" ? "F" : "C"}${name.charAt(0).toUpperCase()}0000${letter()}`;
    const body = `${stateCode}${pan}1Z`;
    const gstin = `${body}${gstinCheckDigit(body)}`;
    if (!used.has(gstin)) {
      used.add(gstin);
      return gstin;
    }
  }
}

/** The six returns before the reference date: GSTR-3B for 2026-04 to 2026-09, due on the 20th of the next month. */
const PERIODS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const dueOf = (period: string) => {
  const [year = 0, month = 0] = period.split("-").map(Number);
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 20));
};
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

// Who is who: stories come from the manifest, so nothing existing is renamed or regraded.
const stories = manifest.stories as Record<string, any>;
const protectedIds = new Set<string>([
  stories.reliableBuyer.buyer, stories.latePayer.buyer, stories.newBuyer.buyer, stories.amountAnomaly.supplier,
  ...stories.fraudRing.companies, ...stories.hiddenOwner.companies, ...stories.sharedAddress.companies, ...Object.values(links),
]);

// How each buyer has actually paid, from the existing invoices. Used only to make profiles agree with it.
const onTimeShare = new Map<string, number>();
for (const company of companies) {
  const settled = invoices.filter((invoice) => invoice.buyerId === company.id && invoice.status !== "open");
  const onTime = settled.filter((invoice) => invoice.paidDate !== null && invoice.paidDate <= invoice.dueDate).length;
  onTimeShare.set(company.id, settled.length ? onTime / settled.length : 0.75);
}

const buyers = companies.filter((company) => (company.type === "buyer" || company.type === "both") && invoices.some((invoice) => invoice.buyerId === company.id));
const badCandidates = buyers
  .filter((company) => ["large", "medium"].includes(company.size) && !protectedIds.has(company.id))
  .sort((a, b) => (onTimeShare.get(a.id) ?? 1) - (onTimeShare.get(b.id) ?? 1));
const clearlyBad = new Set<string>([stories.latePayer.buyer, ...badCandidates.slice(0, 2).map((company) => company.id)]);

// Fraud cases: two suppliers outside every planted story, each with a seeded invoice to point at.
const storySuppliers = new Set(invoices.filter((invoice) => invoice.id.startsWith("DEMO-")).map((invoice) => invoice.supplierId));
const supplierPool = companies.filter((company) => company.type !== "buyer" && !protectedIds.has(company.id) && !storySuppliers.has(company.id) && !clearlyBad.has(company.id) && invoices.some((invoice) => invoice.supplierId === company.id));
const cancelled = supplierPool[0];
const mismatched = supplierPool.find((company) => company.id !== cancelled?.id && company.size === "small") ?? supplierPool[1];
if (!cancelled || !mismatched) throw new Error("Not enough suppliers to plant the fraud cases");

const RATINGS = ["AAA", "AA", "A", "BBB", "BB", "B", "C", "D"] as const;
const WRONG_NAMES = ["SHREE LAXMI STEEL TRADERS", "OMKAR METAL AGENCIES", "NAVJEEVAN HARDWARE STORES", "KESARI TIMBER DEPOT"];

const registryEntries: Record<string, unknown> = {};
const profiles: Record<string, unknown> = {};

for (const company of companies) {
  const gstin = mockGstin(company.name, company.city, company.size);
  const isCancelled = company.id === cancelled.id;
  const isMismatch = company.id === mismatched.id;

  // The filing record follows the company's existing filing rate: that many of 6 on time, the rest late or missing.
  const onTimeCount = isCancelled ? 3 : Math.round(company.gstFilingRate * 6);
  const order = [...PERIODS.keys()].sort(() => rand() - 0.5);
  const lateSlots = new Set(order.slice(0, 6 - onTimeCount));
  const filings = PERIODS.map((period, index) => {
    const due = dueOf(period);
    const missing = { period, return: "GSTR-3B", status: "not_filed" as const, dueDate: isoDay(due) };
    if (isCancelled && index >= 3) return missing;
    if (lateSlots.has(index)) {
      return company.gstFilingRate < 0.8 && rand() < 0.4
        ? missing
        : { period, return: "GSTR-3B", status: "filed_late" as const, dueDate: isoDay(due), filedOn: isoDay(new Date(due.getTime() + whole(3, 25) * 86_400_000)) };
    }
    return { period, return: "GSTR-3B", status: "filed_on_time" as const, dueDate: isoDay(due), filedOn: isoDay(new Date(due.getTime() - whole(1, 12) * 86_400_000)) };
  });
  const regularity = Math.round((filings.filter((filing) => filing.status === "filed_on_time").length / filings.length) * 100) / 100;

  const registration = new Date(Date.UTC(Math.min(company.foundedYear, 2025), whole(0, 11), whole(1, 28)));
  registryEntries[gstin] = {
    legalName: isMismatch ? pick(WRONG_NAMES) : company.name.toUpperCase(),
    tradeName: company.name,
    status: isCancelled ? "Cancelled" : "Active",
    registrationDate: isoDay(registration),
    ...(isCancelled ? { cancellationDate: "2026-05-14", cancellationReason: "Suo moto cancellation: returns not filed" } : {}),
    filings,
  };

  // External profile: tier from how the company really pays in the existing invoices, with the planted bad buyers pushed far down.
  const share = onTimeShare.get(company.id) ?? 0.75;
  const tier = clearlyBad.has(company.id) ? "bad" : share >= 0.85 ? "good" : share >= 0.6 ? "average" : "weak";
  const bureauScore = { good: whole(745, 830), average: whole(660, 740), weak: whole(590, 660), bad: whole(470, 560) }[tier];
  const isBuyer = company.type !== "supplier";
  const large = company.size === "large";
  const ratingIndex = { good: whole(0, 2), average: whole(2, 4), weak: whole(4, 5), bad: whole(6, 7) }[tier];
  const dues = !isBuyer || company.size === "micro" ? 0 : { good: 0, average: pick([0, 0, 180_000, 420_000]), weak: pick([650_000, 900_000, 1_400_000]), bad: whole(32, 74) * 100_000 }[tier];
  // The planted good buyer is clean by design; every other value above is drawn as before.
  const cleanStory = company.id === stories.reliableBuyer.buyer;
  const complaints = cleanStory || !isBuyer ? 0 : { good: pick([0, 0, 0, 1]), average: pick([0, 1, 1, 2]), weak: pick([2, 3]), bad: whole(7, 15) }[tier];
  const [, stateAbbr] = STATE_BY_CITY[company.city] ?? ["27", "MH"];
  profiles[company.id] = {
    gstin,
    // District 99 does not exist, so no real Udyam number can match.
    udyam: large ? null : `UDYAM-${stateAbbr}-99-${String(whole(1, 9_999_999)).padStart(7, "0")}`,
    bureauScore: isCancelled ? Math.min(bureauScore, 610) : bureauScore,
    ...(large && isBuyer ? { creditRating: RATINGS[ratingIndex] } : {}),
    msme1DuesOver45DaysInr: cleanStory ? 0 : dues,
    samadhaanComplaints: complaints,
    gstFilingRegularity: regularity,
  };
}

const firstInvoice = (predicate: (invoice: (typeof invoices)[number]) => boolean) => invoices.find(predicate)?.id;
const storyOut = {
  goodBuyer: { invoiceId: stories.reliableBuyer.invoiceId, buyer: stories.reliableBuyer.buyer },
  newBuyer: { invoiceId: stories.newBuyer.invoiceId, buyer: stories.newBuyer.buyer },
  // Each story's invoice involves only that story's problem, so a test can't pass or fail for another reason.
  badBuyers: [...clearlyBad].map((id) => ({ buyer: id, invoiceId: id === stories.latePayer.buyer ? stories.latePayer.invoiceId : firstInvoice((invoice) => invoice.buyerId === id && invoice.supplierId !== cancelled.id && invoice.supplierId !== mismatched.id) })),
  cancelledGstin: { supplier: cancelled.id, invoiceId: firstInvoice((invoice) => invoice.supplierId === cancelled.id && !clearlyBad.has(invoice.buyerId)) },
  nameMismatch: { supplier: mismatched.id, invoiceId: firstInvoice((invoice) => invoice.supplierId === mismatched.id && !clearlyBad.has(invoice.buyerId)) },
};

const meta = { source: "mock", notice: NOTICE, referenceDate: manifest.referenceDate };
writeFileSync(`${DIR}gst-registry.json`, `${JSON.stringify({ ...meta, entries: registryEntries }, null, 2)}\n`);
writeFileSync(`${DIR}external-profiles.json`, `${JSON.stringify({ ...meta, profiles, stories: storyOut }, null, 2)}\n`);
console.log(`Wrote ${Object.keys(registryEntries).length} registry entries and ${Object.keys(profiles).length} profiles.`);
console.log(JSON.stringify(storyOut, null, 2));
