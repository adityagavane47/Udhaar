/**
 * Generates the simulated risk dataset in data/risk/. Same seed, same files: every value comes from
 * the seeded generator and a fixed reference date, never the system clock.
 *
 * Usage: npm run generate-data
 * Sources and assumptions are in docs/DATA.md. All of it is fictional.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { faker } from "@faker-js/faker/locale/en_IN";

const OUTPUT = fileURLToPath(new URL("../data/risk/", import.meta.url));
const SEED = 20261101;
const REFERENCE_DATE = "2026-11-01";
const REF_MS = Date.parse(`${REFERENCE_DATE}T00:00:00Z`);
const DAY_MS = 86_400_000;

faker.seed(SEED);
faker.setDefaultRefDate(new Date(REF_MS));

type Size = "micro" | "small" | "medium" | "large";
type CompanyType = "supplier" | "buyer" | "both";

interface Company {
  id: string;
  name: string;
  type: CompanyType;
  foundedYear: number;
  size: Size;
  gstFilingRate: number;
  city: string;
  address: string;
  phone: string;
}
interface Director {
  id: string;
  name: string;
  companyIds: string[];
}
interface Invoice {
  id: string;
  supplierId: string;
  buyerId: string;
  amount: number;
  issueDate: string;
  dueDate: string;
  paidDate: string | null;
  status: "paid" | "overdue" | "open";
  discountRatePctPa: number;
}

/** Mean days from invoice to payment, by supplier size. The ratios come from the report: see docs/DATA.md. */
const TARGET_DEBTOR_DAYS: Record<Exclude<Size, "large">, number> = { micro: 122, small: 56, medium: 43 };
const MEDIAN_AMOUNT: Record<Exclude<Size, "large">, number> = { micro: 75_000, small: 3_00_000, medium: 12_00_000 };

// Uniform and bell-curve helpers built only on the seeded generator.
const uniform = (min: number, max: number) => faker.number.float({ min, max });
const whole = (min: number, max: number) => faker.number.int({ min, max });
const pick = <T>(items: readonly T[]): T => faker.helpers.arrayElement(items);
const logNormal = (median: number, sigma: number) => median * Math.exp(sigma * Math.sqrt(-2 * Math.log(uniform(1e-9, 1))) * Math.cos(2 * Math.PI * uniform(0, 1)));
const round2 = (value: number) => Math.round(value * 100) / 100;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Whole thousands, so any invoice divides into ₹1,000 units. */
const toThousands = (rupees: number) => Math.max(1000, Math.round(rupees / 1000) * 1000);

const CITIES = [
  ["Mumbai", "27"], ["Pune", "27"], ["Nagpur", "27"], ["Nashik", "27"], ["Bengaluru", "29"], ["Chennai", "33"], ["Coimbatore", "33"], ["Hyderabad", "36"],
  ["Ahmedabad", "24"], ["Surat", "24"], ["Delhi", "07"], ["Kolkata", "19"], ["Jaipur", "08"], ["Lucknow", "09"], ["Indore", "23"], ["Kochi", "32"],
] as const;
const STATE_BY_CITY = new Map<string, string>(CITIES);

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function gstinCheckDigit(body: string) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const product = BASE36.indexOf(body.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36.charAt((36 - (sum % 36)) % 36);
}

/** Right format, deliberately wrong check digit, so it can't be any real taxpayer's GSTIN. */
function fakeGstin(city: string) {
  const letters = () => faker.string.alpha({ length: 1, casing: "upper" });
  const pan = `${letters()}${letters()}${letters()}C${letters()}${faker.string.numeric(4)}${letters()}`;
  const body = `${STATE_BY_CITY.get(city) ?? "27"}${pan}1Z`;
  return `${body}${BASE36.charAt((BASE36.indexOf(gstinCheckDigit(body)) + 1) % 36)}`;
}

const PREFIXES = ["Navrang", "Sahyog", "Vrindavan", "Kalyani", "Shubham", "Anandi", "Prabhat", "Ujwal", "Saraswati", "Devgiri", "Tejas", "Sundaram", "Hemant", "Omkar", "Nilgiri", "Vasant", "Janak", "Malhar", "Kesari", "Rohini", "Amrit", "Chandan", "Gomati", "Indrayani"];
const SECTORS: Record<CompanyType, string[]> = {
  supplier: ["Rebar Works", "Sand Supply", "Paint Depot", "Tile Supply", "Pipe Fittings", "Electricals", "Timber Mart", "Packaging Works", "Aggregates", "Fasteners"],
  buyer: ["Infra Projects", "Realty", "Constructions", "Developers", "Retail Chain", "Engineering Projects"],
  both: ["Fabricators", "Precast Works", "Modular Interiors", "Glass Works"],
};
const SUFFIX: Record<Size, string> = { micro: "& Co", small: "Enterprises", medium: "Pvt Ltd", large: "Ltd" };

const companies: Company[] = [];
const directors: Director[] = [];
const invoices: Invoice[] = [];
const usedNames = new Set<string>();
const usedAddresses = new Set<string>();

function uniqueAddress(city: string) {
  for (;;) {
    const address = `${whole(1, 480)}, ${faker.location.street()}, ${city}`;
    if (!usedAddresses.has(address)) {
      usedAddresses.add(address);
      return address;
    }
  }
}

function addCompany(fields: { type: CompanyType; size: Size } & Partial<Company>): Company {
  const city = fields.city ?? pick(CITIES)[0];
  let name = fields.name;
  while (!name || (usedNames.has(name) && !fields.name)) name = `${pick(PREFIXES)} ${pick(SECTORS[fields.type])} ${SUFFIX[fields.size]}`;
  usedNames.add(name);
  const company: Company = {
    id: fakeGstin(city),
    name,
    type: fields.type,
    foundedYear: fields.foundedYear ?? whole(1998, 2021),
    size: fields.size,
    gstFilingRate: fields.gstFilingRate ?? round2(uniform(0.78, 0.99)),
    city,
    address: fields.address ?? uniqueAddress(city),
    phone: fields.phone ?? `+91 ${whole(20, 99)} 555 0${whole(100, 999)}`,
  };
  companies.push(company);
  return company;
}

/** Uses Faker's name parts directly, because fullName() can add suffixes such as "IV". */
function newDirector(companyIds: string[]): Director {
  const director = { id: `DIR-${String(directors.length + 1).padStart(3, "0")}`, name: `${faker.person.firstName()} ${faker.person.lastName()}`, companyIds };
  directors.push(director);
  return director;
}

let nextInvoice = 1;
/** Settled invoices get a rate that follows how well the buyer pays, within 6.5–9% a year. */
function addInvoice(supplier: Company, buyer: Company, input: { amount: number; issueMs: number; termsDays: number; paidMs: number | null; discipline: number; id?: string }) {
  const dueMs = input.issueMs + input.termsDays * DAY_MS;
  const paid = input.paidMs !== null && input.paidMs <= REF_MS ? input.paidMs : null;
  const quality = Math.min(1, Math.max(0, (input.discipline - 0.6) / 0.8));
  const invoice: Invoice = {
    id: input.id ?? `SEED-${String(nextInvoice++).padStart(4, "0")}`,
    supplierId: supplier.id,
    buyerId: buyer.id,
    amount: toThousands(input.amount),
    issueDate: isoDay(input.issueMs),
    dueDate: isoDay(dueMs),
    paidDate: paid === null ? null : isoDay(paid),
    status: paid !== null ? "paid" : dueMs < REF_MS ? "overdue" : "open",
    discountRatePctPa: round2(Math.min(9, Math.max(6.5, 6.5 + 2.5 * quality + uniform(-0.25, 0.25)))),
  };
  invoices.push(invoice);
  return invoice;
}

const pastIssue = (minDays = 75, maxDays = 700) => REF_MS - whole(minDays, maxDays) * DAY_MS;
const terms = () => pick([30, 45, 45, 60]);

/** Pays on or just before the due date, or a set number of days after it. */
function plantedInvoice(supplier: Company, buyer: Company, amount: number, daysLate: number, discipline: number) {
  const termsDays = terms();
  const issueMs = pastIssue(termsDays + Math.max(daysLate, 0) + 5);
  addInvoice(supplier, buyer, { amount, issueMs, termsDays, paidMs: issueMs + (termsDays + daysLate) * DAY_MS, discipline });
}

const openInvoice = (id: string, supplier: Company, buyer: Company, amount: number) =>
  addInvoice(supplier, buyer, { id, amount, issueMs: REF_MS - 5 * DAY_MS, termsDays: 90, paidMs: null, discipline: 1 });

// ---- Planted companies. The two real demo accounts match the frontend's profiles of them.
const bigBuild = addCompany({ name: "BigBuild Ltd", type: "buyer", size: "large", foundedYear: 2003, gstFilingRate: 0.99, city: "Mumbai", address: "Tower 4, BKC, Mumbai", phone: "+91 22 555 0200" });
const ramesh = addCompany({ name: "Ramesh Cement Traders", type: "supplier", size: "small", foundedYear: 2011, gstFilingRate: 0.97, city: "Pune", address: "12 MIDC Road, Pune", phone: "+91 98 555 0111" });
const latePayer = addCompany({ type: "buyer", size: "large", foundedYear: 2006, gstFilingRate: 0.93 });
const newBuyer = addCompany({ type: "buyer", size: "small", foundedYear: 2025, gstFilingRate: 0.82 });
const ringX = addCompany({ type: "both", size: "small", foundedYear: 2022, gstFilingRate: 0.86 });
const ringY = addCompany({ type: "both", size: "small", foundedYear: 2022, gstFilingRate: 0.88 });
const ringZ = addCompany({ type: "both", size: "small", foundedYear: 2023, gstFilingRate: 0.84 });
const hiddenSupplier = addCompany({ type: "supplier", size: "micro", foundedYear: 2019 });
const hiddenBuyer = addCompany({ type: "buyer", size: "medium", foundedYear: 2010, gstFilingRate: 0.94 });
const addressSupplier = addCompany({ type: "supplier", size: "micro", foundedYear: 2017 });
const addressBuyer = addCompany({ type: "buyer", size: "medium", foundedYear: 2012, gstFilingRate: 0.92, city: addressSupplier.city, address: addressSupplier.address });
const anomalySupplier = addCompany({ type: "supplier", size: "micro", foundedYear: 2014, gstFilingRate: 0.92 });
const steadyBuyer = addCompany({ type: "buyer", size: "large", foundedYear: 2005, gstFilingRate: 0.96 });

// ---- Background companies: 37, for 50 in all.
const backgroundSellers: { company: Company; size: Exclude<Size, "large"> }[] = [];
for (const [size, count] of [["micro", 9], ["small", 7], ["medium", 4]] as const) {
  for (let i = 0; i < count; i++) backgroundSellers.push({ company: addCompany({ type: "supplier", size }), size });
}
const backgroundMakers: { company: Company; size: "small" | "medium" }[] = [];
for (const size of ["small", "small", "medium", "medium", "medium"] as const) backgroundMakers.push({ company: addCompany({ type: "both", size }), size });
const backgroundBuyers: Company[] = [];
for (let i = 0; i < 12; i++) backgroundBuyers.push(addCompany({ type: "buyer", size: i < 5 ? "medium" : "large" }));

// How promptly each buyer pays: below 1 is faster than the average for that supplier size.
const discipline = new Map<string, number>([[steadyBuyer.id, 0.62], [hiddenBuyer.id, 0.68], [addressBuyer.id, 0.68]]);
for (const buyer of backgroundBuyers) discipline.set(buyer.id, round2(uniform(0.75, 1.3)));
for (const { company } of backgroundMakers) discipline.set(company.id, round2(uniform(0.85, 1.3)));

// ---- Directors. Each sits on one board, apart from the planted owner and a few harmless overlaps.
for (const [index, company] of companies.entries()) {
  if (company === hiddenBuyer) continue;
  newDirector([company.id]);
  if (index % 5 < 2) newDirector([company.id]);
}
const hiddenOwner = directors.find((director) => director.companyIds.includes(hiddenSupplier.id));
if (!hiddenOwner) throw new Error("Hidden owner was not created");
hiddenOwner.companyIds.push(hiddenBuyer.id);
newDirector([hiddenBuyer.id]);
// Two suppliers that never bill each other can share a director without any fraud signal.
for (const [a, b] of [[0, 4], [2, 7]] as const) {
  const shared = directors.find((director) => director.companyIds.includes(backgroundSellers[a]?.company.id ?? ""));
  const other = backgroundSellers[b]?.company.id;
  if (shared && other) shared.companyIds.push(other);
}
for (let i = 0; directors.length < 80; i++) {
  const company = companies[i % companies.length];
  if (company && company !== hiddenBuyer) newDirector([company.id]);
}

// ---- Planted histories.
// Reliable buyer: 30 settled invoices, 29 on time (97%) and 1 a few days late.
const reliableSuppliers = backgroundSellers.filter(({ size }) => size !== "micro").slice(0, 6).map(({ company }) => company);
for (let i = 0; i < 30; i++) {
  const late = i === 17;
  if (i < 9) plantedInvoice(ramesh, bigBuild, logNormal(5_00_000, 0.18), whole(-8, 0), 0.6);
  else plantedInvoice(reliableSuppliers[i % reliableSuppliers.length] ?? ramesh, bigBuild, logNormal(5_00_000, 0.3), late ? whole(3, 8) : whole(-8, 0), 0.6);
}
// Ramesh also sells to other prompt payers, at the same usual size.
for (let i = 0; i < 5; i++) plantedInvoice(ramesh, steadyBuyer, logNormal(5_00_000, 0.18), whole(-6, 0), 0.62);

// Late payer: 30 settled. 26 are 20–40 days late, and the other 4 are on time.
const lateSuppliers = backgroundSellers.filter(({ size }) => size === "small").map(({ company }) => company);
for (let i = 0; i < 30; i++) {
  plantedInvoice(lateSuppliers[i % lateSuppliers.length] ?? ramesh, latePayer, logNormal(3_00_000, 0.35), i % 7 === 3 ? whole(-3, 0) : whole(20, 40), 1.4);
}

// Fraud ring: X bills Y, Y bills Z, Z bills X, and they trade with no one else.
for (const [from, to] of [[ringX, ringY], [ringY, ringZ], [ringZ, ringX]] as const) {
  for (let i = 0; i < 4; i++) plantedInvoice(from, to, logNormal(8_00_000, 0.1), whole(-5, 0), 0.7);
}

for (let i = 0; i < 4; i++) plantedInvoice(hiddenSupplier, hiddenBuyer, logNormal(1_50_000, 0.2), whole(-5, 0), 0.68);
for (let i = 0; i < 4; i++) plantedInvoice(addressSupplier, addressBuyer, logNormal(1_50_000, 0.2), whole(-5, 0), 0.68);

// Amount anomaly: a supplier who bills about ₹50,000, every time.
for (let i = 0; i < 12; i++) plantedInvoice(anomalySupplier, steadyBuyer, logNormal(50_000, 0.15), whole(-6, 0), 0.62);

// ---- Background trade only flows upward: suppliers to makers or buyers, makers to buyers. That
// keeps the billing graph free of loops, so the only cycle in the data is the planted one.
const midBuyers = backgroundMakers.map(({ company }) => company);
const topBuyers = [...backgroundBuyers, steadyBuyer, hiddenBuyer, addressBuyer];
const backgroundTarget = 500 - invoices.length - 7;
const plantedCount = invoices.length;

function backgroundInvoice(seller: Company, size: Exclude<Size, "large">, buyer: Company) {
  const termsDays = terms();
  const buyerDiscipline = discipline.get(buyer.id) ?? 1;
  const issueMs = pastIssue(10, 700);
  const debtorDays = logNormal(TARGET_DEBTOR_DAYS[size] * buyerDiscipline, 0.2);
  addInvoice(seller, buyer, { amount: logNormal(MEDIAN_AMOUNT[size], 0.45), issueMs, termsDays, paidMs: issueMs + Math.round(debtorDays) * DAY_MS, discipline: buyerDiscipline });
}

const sellerRoster = [
  ...backgroundSellers.map(({ company, size }) => ({ company, size, buyers: faker.helpers.arrayElements([...topBuyers, ...midBuyers], { min: 3, max: 6 }) })),
  ...backgroundMakers.map(({ company, size }) => ({ company, size: size as Exclude<Size, "large">, buyers: faker.helpers.arrayElements(topBuyers, { min: 3, max: 5 }) })),
  { company: hiddenSupplier, size: "micro" as const, buyers: faker.helpers.arrayElements(backgroundBuyers, 2) },
  { company: addressSupplier, size: "micro" as const, buyers: faker.helpers.arrayElements(backgroundBuyers, 2) },
];
for (let i = 0; i < backgroundTarget; i++) {
  const seller = sellerRoster[i % sellerRoster.length];
  if (!seller) break;
  backgroundInvoice(seller.company, seller.size, pick(seller.buyers));
}

// ---- One open invoice per story, 90 days from the reference date. These are what the demo scores.
const lateSupplier = lateSuppliers[0] ?? ramesh;
const firstSmall = reliableSuppliers[1] ?? ramesh;
const stories = {
  reliableBuyer: { invoiceId: openInvoice("DEMO-RELIABLE", ramesh, bigBuild, 5_00_000).id, buyer: bigBuild.id },
  latePayer: { invoiceId: openInvoice("DEMO-LATE", lateSupplier, latePayer, 3_00_000).id, buyer: latePayer.id },
  newBuyer: { invoiceId: openInvoice("DEMO-NEW", firstSmall, newBuyer, 3_00_000).id, buyer: newBuyer.id },
  fraudRing: { invoiceId: openInvoice("DEMO-RING", ringZ, ringX, 8_00_000).id, companies: [ringX.id, ringY.id, ringZ.id] },
  hiddenOwner: { invoiceId: openInvoice("DEMO-HIDDEN", hiddenSupplier, hiddenBuyer, 1_50_000).id, director: hiddenOwner.id, companies: [hiddenSupplier.id, hiddenBuyer.id] },
  sharedAddress: { invoiceId: openInvoice("DEMO-ADDRESS", addressSupplier, addressBuyer, 1_50_000).id, companies: [addressSupplier.id, addressBuyer.id] },
  amountAnomaly: { invoiceId: openInvoice("DEMO-ANOMALY", anomalySupplier, steadyBuyer, 40_00_000).id, supplier: anomalySupplier.id },
};

// ---- Measure the result, and refuse to write data that misses the report's ratios.
const sizeOf = new Map(companies.map((company) => [company.id, company.size]));
const backgroundSellerIds = new Set(sellerRoster.map((seller) => seller.company.id));
const measured: Record<string, number[]> = { micro: [], small: [], medium: [] };
for (const invoice of invoices.slice(plantedCount)) {
  if (!invoice.paidDate || !backgroundSellerIds.has(invoice.supplierId)) continue;
  measured[sizeOf.get(invoice.supplierId) ?? ""]?.push((Date.parse(invoice.paidDate) - Date.parse(invoice.issueDate)) / DAY_MS);
}
const mean = (values: number[] = []) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const debtorDays = { micro: Math.round(mean(measured.micro)), small: Math.round(mean(measured.small)), medium: Math.round(mean(measured.medium)) };
const ratios = { microToSmall: round2(debtorDays.micro / debtorDays.small), microToMedium: round2(debtorDays.micro / debtorDays.medium) };
if (ratios.microToSmall <= 2 || ratios.microToMedium < 2.4 || ratios.microToMedium >= 3) {
  throw new Error(`Payment delays miss the report's ratios: ${JSON.stringify(ratios)}`);
}
const rates = invoices.map((invoice) => invoice.discountRatePctPa);

const manifest = {
  notice: "Simulated data. Every company, person and invoice is fictional. See docs/DATA.md.",
  seed: SEED,
  referenceDate: REFERENCE_DATE,
  counts: { companies: companies.length, directors: directors.length, invoices: invoices.length },
  calibration: { meanDebtorDays: debtorDays, ratios, discountRatePctPa: { min: Math.min(...rates), max: Math.max(...rates) } },
  stories,
};

mkdirSync(OUTPUT, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(`${OUTPUT}${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
write("companies", companies);
write("directors", directors);
write("invoices", invoices);
write("account-links", { BUYER: bigBuild.id, BUSINESS: ramesh.id });
write("manifest", manifest);

console.log(`${companies.length} companies, ${directors.length} directors, ${invoices.length} invoices`);
console.log(`Mean days to payment: micro ${debtorDays.micro}, small ${debtorDays.small}, medium ${debtorDays.medium} (micro is ${ratios.microToSmall}x small, ${ratios.microToMedium}x medium)`);
