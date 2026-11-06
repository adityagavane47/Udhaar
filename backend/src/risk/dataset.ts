import { readFileSync } from "node:fs";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError } from "../errors.js";
import type { GraphStore } from "./graphStore.js";
import { InMemoryGraphStore } from "./memoryGraphStore.js";

const companySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["supplier", "buyer", "both"]),
  foundedYear: z.number().int(),
  size: z.enum(["micro", "small", "medium", "large"]),
  gstFilingRate: z.number().min(0).max(1),
  city: z.string(),
  address: z.string().min(1),
  phone: z.string(),
});
const directorSchema = z.object({ id: z.string().min(1), name: z.string().min(1), companyIds: z.array(z.string()) });
const invoiceSchema = z.object({
  id: z.string().min(1),
  supplierId: z.string().min(1),
  buyerId: z.string().min(1),
  amount: z.number().positive(),
  issueDate: z.string(),
  dueDate: z.string(),
  paidDate: z.string().nullable(),
  status: z.enum(["paid", "overdue", "open"]),
  discountRatePctPa: z.number(),
});
const manifestSchema = z.object({
  referenceDate: z.string(),
  counts: z.object({ companies: z.number(), directors: z.number(), invoices: z.number() }),
});

export type Company = z.infer<typeof companySchema>;
export type SeedInvoice = z.infer<typeof invoiceSchema>;

export interface RiskDataset {
  referenceDate: string;
  companies: Map<string, Company>;
  invoices: SeedInvoice[];
  invoicesById: Map<string, SeedInvoice>;
  /** Hedera account ID to company ID, for the real demo accounts. */
  accountLinks: Map<string, string>;
  graph: GraphStore;
}

const readJson = (name: string): unknown => JSON.parse(readFileSync(`${config.riskDataDir}${name}.json`, "utf8"));

function load(): RiskDataset {
  const manifest = manifestSchema.parse(readJson("manifest"));
  const companies = z.array(companySchema).parse(readJson("companies"));
  const directors = z.array(directorSchema).parse(readJson("directors"));
  const invoices = z.array(invoiceSchema).parse(readJson("invoices"));
  const links = z.record(z.string(), z.string()).parse(readJson("account-links"));

  if (companies.length !== manifest.counts.companies || directors.length !== manifest.counts.directors || invoices.length !== manifest.counts.invoices) {
    throw new Error("The risk data files don't match their manifest");
  }
  const companiesById = new Map(companies.map((company) => [company.id, company]));
  for (const invoice of invoices) {
    if (!companiesById.has(invoice.supplierId) || !companiesById.has(invoice.buyerId)) throw new Error(`${invoice.id} names an unknown company`);
  }

  // A missing account ID must fail here: otherwise a real company would quietly score as new.
  const accountLinks = new Map<string, string>();
  for (const [role, companyId] of Object.entries(links)) {
    const accountId = process.env[`${role}_ID`]?.trim();
    if (!accountId) throw new Error(`${role}_ID is not set, so its company link can't be resolved`);
    if (!companiesById.has(companyId)) throw new Error(`${role} links to an unknown company`);
    accountLinks.set(accountId, companyId);
  }

  return {
    referenceDate: manifest.referenceDate,
    companies: companiesById,
    invoices,
    invoicesById: new Map(invoices.map((invoice) => [invoice.id, invoice])),
    accountLinks,
    graph: new InMemoryGraphStore({ companies, directors, invoices }),
  };
}

let cached: RiskDataset | undefined;

/** Only a successful load is kept, so a failure is retried and never replaced by empty data. */
export function loadDataset(): RiskDataset {
  if (cached) return cached;
  try {
    cached = load();
    return cached;
  } catch (error) {
    throw new ApiError(503, "RISK_DATA_UNAVAILABLE", `The risk data could not be loaded, so no score was produced: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
