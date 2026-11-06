/**
 * MOCK external data: the GST registry and the credit profiles. Nothing here is real, and every
 * response that uses it says so with source: "mock".
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError } from "../errors.js";
import { validateGstin, validateUdyam } from "./gstin.js";

export const MOCK_SOURCE = "mock" as const;

const filingSchema = z.object({
  period: z.string(),
  return: z.string(),
  status: z.enum(["filed_on_time", "filed_late", "not_filed"]),
  dueDate: z.string(),
  filedOn: z.string().optional(),
});
const registryEntrySchema = z.object({
  legalName: z.string(),
  tradeName: z.string(),
  status: z.enum(["Active", "Cancelled"]),
  registrationDate: z.string(),
  cancellationDate: z.string().optional(),
  cancellationReason: z.string().optional(),
  filings: z.array(filingSchema).length(6),
});
const profileSchema = z.object({
  gstin: z.string(),
  udyam: z.string().nullable(),
  /** CIBIL-style, 300 to 900. */
  bureauScore: z.number().int().min(300).max(900),
  creditRating: z.enum(["AAA", "AA", "A", "BBB", "BB", "B", "C", "D"]).optional(),
  /** Rupees owed to micro and small suppliers for more than 45 days, as declared in MSME-1. */
  msme1DuesOver45DaysInr: z.number().min(0),
  /** Delayed-payment complaints on MSME Samadhaan. */
  samadhaanComplaints: z.number().int().min(0),
  gstFilingRegularity: z.number().min(0).max(1),
});
const storiesSchema = z.object({
  goodBuyer: z.object({ invoiceId: z.string(), buyer: z.string() }),
  newBuyer: z.object({ invoiceId: z.string(), buyer: z.string() }),
  badBuyers: z.array(z.object({ buyer: z.string(), invoiceId: z.string().optional() })),
  cancelledGstin: z.object({ supplier: z.string(), invoiceId: z.string().optional() }),
  nameMismatch: z.object({ supplier: z.string(), invoiceId: z.string().optional() }),
});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export type ExternalProfile = z.infer<typeof profileSchema>;
export type Filing = z.infer<typeof filingSchema>;

const readJson = (name: string): unknown => JSON.parse(readFileSync(`${config.riskDataDir}${name}.json`, "utf8"));

interface TrustData {
  registry: Map<string, RegistryEntry>;
  profiles: Map<string, ExternalProfile>;
  stories: z.infer<typeof storiesSchema>;
}

let cached: TrustData | undefined;

export function loadTrustData(): TrustData {
  if (cached) return cached;
  try {
    const registry = z.object({ source: z.literal("mock"), entries: z.record(z.string(), registryEntrySchema) }).parse(readJson("gst-registry"));
    const external = z.object({ source: z.literal("mock"), profiles: z.record(z.string(), profileSchema), stories: storiesSchema }).parse(readJson("external-profiles"));
    cached = { registry: new Map(Object.entries(registry.entries)), profiles: new Map(Object.entries(external.profiles)), stories: external.stories };
    return cached;
  } catch (error) {
    throw new ApiError(503, "TRUST_DATA_UNAVAILABLE", `The mock trust data could not be loaded, so no trust result was produced: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

/** Upper case, no punctuation, and the usual company-name endings made uniform, so "Ltd." and "LIMITED" match. */
export function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\bPRIVATE\b/g, "PVT")
    .replace(/\bLIMITED\b/g, "LTD")
    .replace(/\s+/g, " ")
    .trim();
}

export type StepStatus = "pass" | "warn" | "fail";

export interface GstStep {
  step: "checksum" | "registry" | "status" | "name" | "filing";
  status: StepStatus;
  detail: string;
}

export interface GstVerification {
  source: "mock";
  gstin: string;
  /** Steps run in order and stop at the first failure, so a mistyped number never reaches the registry. */
  steps: GstStep[];
  checksum: StepStatus;
  /** "not_run" when an earlier step failed. */
  registry: StepStatus | "not_run";
  gstStatus: "Active" | "Cancelled" | "unknown";
  nameMatches: boolean | null;
  registryName?: string;
  filing?: { onTime: number; late: number; notFiled: number; regularity: number; status: StepStatus | "not_run" };
  entry?: RegistryEntry;
  ok: boolean;
}

/** Checksum, then registry lookup, then Active, then legal name, then filing regularity. */
export function verifyGstin(gstin: string, companyName: string): GstVerification {
  const { registry } = loadTrustData();
  const steps: GstStep[] = [];
  const result: GstVerification = { source: MOCK_SOURCE, gstin, steps, checksum: "pass", registry: "not_run", gstStatus: "unknown", nameMatches: null, ok: false };

  const format = validateGstin(gstin);
  if (!format.valid) {
    steps.push({ step: "checksum", status: "fail", detail: `${gstin}: ${format.reason}` });
    return { ...result, checksum: "fail" };
  }
  steps.push({ step: "checksum", status: "pass", detail: `${gstin} has a valid format, a ${format.stateName} state code and a correct check character` });

  const entry = registry.get(format.gstin);
  if (!entry) {
    steps.push({ step: "registry", status: "fail", detail: `${gstin} is not in the (mock) GST registry` });
    return { ...result, registry: "fail" };
  }
  result.registry = "pass";
  result.entry = entry;
  steps.push({ step: "registry", status: "pass", detail: `Found in the (mock) GST registry as ${entry.legalName}, registered ${entry.registrationDate}` });

  result.gstStatus = entry.status;
  if (entry.status !== "Active") {
    steps.push({ step: "status", status: "fail", detail: `Registration is ${entry.status}${entry.cancellationDate ? ` since ${entry.cancellationDate}` : ""}${entry.cancellationReason ? ` (${entry.cancellationReason})` : ""}` });
    return result;
  }
  steps.push({ step: "status", status: "pass", detail: "Registration is Active" });

  result.registryName = entry.legalName;
  result.nameMatches = normalizeName(entry.legalName) === normalizeName(companyName);
  steps.push(result.nameMatches
    ? { step: "name", status: "pass", detail: `Registry legal name ${entry.legalName} matches ${companyName}` }
    : { step: "name", status: "fail", detail: `Registry legal name is ${entry.legalName}, but the company is ${companyName}` });
  if (!result.nameMatches) return result;

  const onTime = entry.filings.filter((filing) => filing.status === "filed_on_time").length;
  const late = entry.filings.filter((filing) => filing.status === "filed_late").length;
  const notFiled = entry.filings.filter((filing) => filing.status === "not_filed").length;
  // 5 or 6 on time is regular, 3 or 4 is patchy, and fewer is a problem.
  const status: StepStatus = onTime >= 5 ? "pass" : onTime >= 3 ? "warn" : "fail";
  result.filing = { onTime, late, notFiled, regularity: onTime / 6, status };
  steps.push({ step: "filing", status, detail: `${onTime} of the last 6 GST returns were filed on time${late ? `, ${late} late` : ""}${notFiled ? `, ${notFiled} not filed` : ""}` });
  result.ok = status !== "fail";
  return result;
}

export { validateUdyam };
