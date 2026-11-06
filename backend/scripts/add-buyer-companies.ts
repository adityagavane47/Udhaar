/**
 * Adds the two real buyer companies to the MOCK risk and trust data, so the accounts made by
 * create-buyer-accounts have a company behind them:
 *
 *   Apex Infra Pvt Ltd  a good buyer: bureau 780, rating A, no MSME-1 dues, no Samadhaan complaints, GST filed on time.
 *   Nova Retail         a risky buyer: bureau 610, MSME-1 dues over ₹10 lakh, 4 Samadhaan complaints, new, GST patchy.
 *
 * EVERYTHING HERE IS FICTIONAL, like the rest of the dataset (see docs/DATA.md). It edits companies.json,
 * account-links.json, gst-registry.json, external-profiles.json and the company count in manifest.json,
 * and nothing else: no existing company, invoice or grade changes. It does not regenerate the dataset,
 * which would reshuffle every planted story. Safe to run twice. A company already added is skipped, and its
 * registry and profile entries are written again, so running it after generate-trust-data puts them back.
 *
 * If you regenerate the dataset, run generate-data, then generate-trust-data, then this, in that order.
 *
 * Usage: npm run add-buyer-companies
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gstinCheckDigit, validateGstin } from "../src/trust/gstin.js";

const DIR = `${fileURLToPath(new URL("../", import.meta.url))}data/risk/`;
const read = (name: string) => JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8")) as any;
const write = (name: string, value: unknown) => writeFileSync(`${DIR}${name}.json`, `${JSON.stringify(value, null, 2)}\n`);

const companies = read("companies") as any[];
const links = read("account-links") as Record<string, string>;
const registry = read("gst-registry");
const external = read("external-profiles");
const manifest = read("manifest");

const day = (iso: string, offset: number) => new Date(Date.parse(iso) + offset * 86_400_000).toISOString().slice(0, 10);
const PERIODS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const dueOf = (period: string) => {
  const [year = 0, month = 0] = period.split("-").map(Number);
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 20)).toISOString().slice(0, 10);
};

/** A company ID in the dataset's look-alike format. It must fail the GSTIN checksum, so it can never be a real number. */
function fictionalCompanyId(seed: string): string {
  for (let i = 0; i < 26; i++) {
    const id = `27${seed}1Z${String.fromCharCode(65 + i)}`;
    if (!validateGstin(id).valid && !companies.some((company) => company.id === id)) return id;
  }
  throw new Error(`No usable company ID for ${seed}`);
}

/** A checksum-valid mock GSTIN with PAN serial 0000, which is not known to be issued to anyone. */
function mockGstin(pan: string): string {
  const body = `27${pan}1Z`;
  return `${body}${gstinCheckDigit(body)}`;
}

type Filing = "on_time" | "late" | "missing";
function filings(pattern: Filing[]) {
  return PERIODS.map((period, index) => {
    const dueDate = dueOf(period);
    const how = pattern[index];
    if (how === "missing") return { period, return: "GSTR-3B", status: "not_filed", dueDate };
    if (how === "late") return { period, return: "GSTR-3B", status: "filed_late", dueDate, filedOn: day(dueDate, 9 + index) };
    return { period, return: "GSTR-3B", status: "filed_on_time", dueDate, filedOn: day(dueDate, -(2 + index)) };
  });
}

const NEW = [
  {
    role: "APEX",
    company: { name: "Apex Infra Pvt Ltd", type: "buyer", foundedYear: 2010, size: "large", gstFilingRate: 1, city: "Nagpur", address: "88 Civil Lines, Nagpur", phone: "+91 71 555 0101" },
    idSeed: "APXIC1042N",
    pan: "APXCA0000N",
    registrationDate: "2010-03-15",
    pattern: ["on_time", "on_time", "on_time", "on_time", "on_time", "on_time"] as Filing[],
    profile: { udyam: null, bureauScore: 780, creditRating: "A", msme1DuesOver45DaysInr: 0, samadhaanComplaints: 0, gstFilingRegularity: 1 },
  },
  {
    role: "NOVA",
    company: { name: "Nova Retail", type: "buyer", foundedYear: 2025, size: "small", gstFilingRate: 0.5, city: "Nashik", address: "5 College Road, Nashik", phone: "+91 25 555 0199" },
    idSeed: "NVRRT9917K",
    pan: "NVRCN0000K",
    registrationDate: "2025-02-10",
    pattern: ["on_time", "late", "on_time", "missing", "late", "on_time"] as Filing[],
    profile: { udyam: "UDYAM-MH-99-0004417", bureauScore: 610, msme1DuesOver45DaysInr: 1_450_000, samadhaanComplaints: 4, gstFilingRegularity: 0.5 },
  },
];

let added = 0;
let refreshed = false;
for (const item of NEW) {
  const gstin = mockGstin(item.pan);
  const existing = companies.find((company) => company.name === item.company.name);
  if (existing) {
    // Already added: only make sure its registry and profile entries are the ones described above.
    registry.entries[gstin] = { legalName: item.company.name.toUpperCase(), tradeName: item.company.name, status: "Active", registrationDate: item.registrationDate, filings: filings(item.pattern) };
    external.profiles[existing.id] = { gstin, ...item.profile };
    links[item.role] = existing.id;
    console.log(`${item.company.name}: already in the dataset, entries refreshed`);
    refreshed = true;
    continue;
  }
  const id = fictionalCompanyId(item.idSeed);
  companies.push({ id, ...item.company });
  links[item.role] = id;
  registry.entries[gstin] = {
    legalName: item.company.name.toUpperCase(),
    tradeName: item.company.name,
    status: "Active",
    registrationDate: item.registrationDate,
    filings: filings(item.pattern),
  };
  external.profiles[id] = { gstin, ...item.profile };
  console.log(`${item.company.name}: company ${id}, mock GSTIN ${gstin}, linked to ${item.role}_ID`);
  added += 1;
}

if (added > 0 || refreshed) {
  manifest.counts.companies = companies.length;
  write("companies", companies);
  write("account-links", links);
  write("gst-registry", registry);
  write("external-profiles", external);
  write("manifest", manifest);
}
console.log(added > 0 || refreshed ? `Done. ${companies.length} companies.` : "Nothing to do.");
