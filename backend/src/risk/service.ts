import { config, hashscan } from "../config.js";
import { ApiError } from "../errors.js";
import { state } from "../store.js";
import type { Invoice, Link } from "../types.js";
import { loadDataset, type Company, type RiskDataset } from "./dataset.js";
import type { GraphPerson, GraphStore } from "./graphStore.js";
import { scoreInvoice, type FraudFindings, type Scorecard } from "./scorecard.js";

/** The one simulated invoice shown beside real ones, so the demo can show a fraud case. */
const MARKETPLACE_DEMO_INVOICE = "DEMO-RING";
const SEEDED_ID = /^(DEMO|SEED)-/;

export const isSeededInvoiceId = (id: string) => SEEDED_ID.test(id);

/** What the scorecard needs from any invoice, real or simulated. */
interface Subject {
  id: string;
  seeded: boolean;
  supplierRef: string;
  buyerRef: string;
  supplierName: string;
  buyerName: string;
  amount: number;
  dueDate: string;
  /** Tokenized invoices are scored as of pricing, so the grade shown stays the grade that set the price. */
  scoredAt: number;
  hashscanUrl: string;
  links: Link[];
  appliedDiscountPct?: number;
}

const seededLinks = (): Link[] => [{ label: "uINR token (this invoice is simulated and has no on-chain record)", url: hashscan.token(config.uinrTokenId) }];

function subjectOf(id: string, dataset: RiskDataset): Subject {
  const real = state.invoices[id];
  if (real) {
    const supplier = companyFor(real.supplierId, dataset);
    const buyer = companyFor(real.buyerId, dataset);
    return {
      id: real.id,
      seeded: false,
      supplierRef: real.supplierId,
      buyerRef: real.buyerId,
      supplierName: supplier?.name ?? real.supplierName,
      buyerName: buyer?.name ?? real.buyerName,
      amount: real.amount,
      dueDate: real.dueDate,
      scoredAt: real.gradedAt ? Date.parse(real.gradedAt) : Date.now(),
      hashscanUrl: real.hashscanUrl ?? hashscan.account(real.supplierId),
      links: real.links,
      ...(real.discountPct !== undefined ? { appliedDiscountPct: real.discountPct } : {}),
    };
  }
  const seeded = dataset.invoicesById.get(id);
  if (!seeded) throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice ${id} not found`);
  const links = seededLinks();
  return {
    id: seeded.id,
    seeded: true,
    supplierRef: seeded.supplierId,
    buyerRef: seeded.buyerId,
    supplierName: dataset.companies.get(seeded.supplierId)?.name ?? seeded.supplierId,
    buyerName: dataset.companies.get(seeded.buyerId)?.name ?? seeded.buyerId,
    amount: seeded.amount,
    dueDate: seeded.dueDate,
    scoredAt: Date.now(),
    hashscanUrl: links[0]?.url ?? "",
    links,
  };
}

/** Real invoices name Hedera accounts and simulated ones name companies. Anything else is unknown, so scored as new. */
function companyFor(ref: string, dataset: RiskDataset): Company | undefined {
  return dataset.companies.get(ref) ?? dataset.companies.get(dataset.accountLinks.get(ref) ?? "");
}

const directorLabel = (index: number) => `Director ${String.fromCharCode(65 + index)}`;

interface Assessment {
  subject: Subject;
  card: Scorecard;
  supplier: Company | undefined;
  buyer: Company | undefined;
  fraud: FraudFindings;
  directors: { supplier: GraphPerson[]; buyer: GraphPerson[] };
  masks: Map<string, string>;
}

/** Takes the graph as an argument so any GraphStore can be used, including one that fails. */
export async function assess(subject: Subject, dataset: RiskDataset, graph: GraphStore): Promise<Assessment> {
  const supplier = companyFor(subject.supplierRef, dataset);
  const buyer = companyFor(subject.buyerRef, dataset);
  const bothKnown = supplier !== undefined && buyer !== undefined;

  const [cycles, sharedDirectors, sharedAddress, supplierDirectors, buyerDirectors] = await Promise.all([
    bothKnown ? graph.findCycles(supplier.id, buyer.id) : [],
    bothKnown ? graph.findSharedDirectors(supplier.id, buyer.id) : [],
    bothKnown ? graph.findSharedAddress(supplier.id, buyer.id) : false,
    supplier ? graph.directorsOf(supplier.id) : [],
    buyer ? graph.directorsOf(buyer.id) : [],
  ]);

  const masks = new Map<string, string>();
  for (const person of [...supplierDirectors, ...buyerDirectors]) {
    if (!masks.has(person.id)) masks.set(person.id, directorLabel(masks.size));
  }

  const fraud = { cycles, sharedDirectors, sharedAddress };
  const card = scoreInvoice({
    invoiceId: subject.id,
    amount: subject.amount,
    dueDate: subject.dueDate,
    now: subject.scoredAt,
    referenceDate: dataset.referenceDate,
    supplier,
    buyer,
    supplierName: subject.supplierName,
    buyerName: subject.buyerName,
    history: dataset.invoices,
    fraud,
    nameOfCompany: (id) => dataset.companies.get(id)?.name ?? id,
    maskPerson: (id) => masks.get(id) ?? "A director",
  });
  return { subject, card, supplier, buyer, fraud, directors: { supplier: supplierDirectors, buyer: buyerDirectors }, masks };
}

/** A failure anywhere ends in an error. There is no fallback score. */
async function assessById(id: string): Promise<Assessment> {
  try {
    const dataset = loadDataset();
    return await assess(subjectOf(id, dataset), dataset, dataset.graph);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "RISK_UNAVAILABLE", `The risk check failed, so no score was produced: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

/** Only the parties involved. People are shown as "Director A", and addresses are never included. */
function buildGraph({ subject, supplier, buyer, fraud, directors, masks }: Assessment, dataset: RiskDataset) {
  const supplierNode = supplier?.id ?? subject.supplierRef;
  const buyerNode = buyer?.id ?? subject.buyerRef;
  const nodes = new Map<string, { id: string; label: string; type: "company" | "person" | "address"; role?: "supplier" | "buyer"; inDataset?: boolean; flagged: boolean }>();
  const links: { source: string; target: string; type: "invoice" | "billed" | "director_of" | "registered_at"; flagged: boolean }[] = [];

  const ringMembers = new Set(fraud.cycles.flat());
  const sharedPeople = new Set(fraud.sharedDirectors.map((person) => person.id));
  const companyFlagged = (id: string) => ringMembers.has(id) || (fraud.sharedAddress && (id === supplierNode || id === buyerNode)) || (fraud.sharedDirectors.length > 0 && (id === supplierNode || id === buyerNode));

  nodes.set(supplierNode, { id: supplierNode, label: subject.supplierName, type: "company", role: "supplier", inDataset: supplier !== undefined, flagged: companyFlagged(supplierNode) });
  nodes.set(buyerNode, { id: buyerNode, label: subject.buyerName, type: "company", role: "buyer", inDataset: buyer !== undefined, flagged: companyFlagged(buyerNode) });
  links.push({ source: supplierNode, target: buyerNode, type: "invoice", flagged: ringMembers.has(supplierNode) });

  for (const cycle of fraud.cycles) {
    for (const [index, from] of cycle.entries()) {
      const to = cycle[(index + 1) % cycle.length] ?? from;
      if (!nodes.has(from)) nodes.set(from, { id: from, label: dataset.companies.get(from)?.name ?? from, type: "company", inDataset: true, flagged: true });
      if (from !== supplierNode || to !== buyerNode) links.push({ source: from, target: to, type: "billed", flagged: true });
    }
  }

  const addPeople = (people: GraphPerson[], companyId: string) => {
    for (const person of people) {
      const id = (masks.get(person.id) ?? "Director").toLowerCase().replace(" ", "-");
      nodes.set(id, { id, label: masks.get(person.id) ?? "Director", type: "person", flagged: sharedPeople.has(person.id) });
      links.push({ source: id, target: companyId, type: "director_of", flagged: sharedPeople.has(person.id) });
    }
  };
  addPeople(directors.supplier, supplierNode);
  addPeople(directors.buyer, buyerNode);

  if (fraud.sharedAddress) {
    nodes.set("shared-address", { id: "shared-address", label: "Shared address", type: "address", flagged: true });
    links.push({ source: supplierNode, target: "shared-address", type: "registered_at", flagged: true }, { source: buyerNode, target: "shared-address", type: "registered_at", flagged: true });
  }
  return { nodes: [...nodes.values()], links };
}

/** Free: grade and confidence only. The score and reasons are for the full report. */
export async function riskSummary(id: string) {
  const { subject, card } = await assessById(id);
  return { invoiceId: subject.id, seeded: subject.seeded, grade: card.grade, confidence: card.confidence, hashscanUrl: subject.hashscanUrl, links: subject.links };
}

export async function riskReport(id: string) {
  const assessment = await assessById(id);
  const { subject, card } = assessment;
  return {
    invoiceId: subject.id,
    seeded: subject.seeded,
    supplier: { name: subject.supplierName, inDataset: assessment.supplier !== undefined },
    buyer: { name: subject.buyerName, inDataset: assessment.buyer !== undefined },
    amount: subject.amount,
    dueDate: subject.dueDate,
    ...card,
    ...(subject.appliedDiscountPct !== undefined ? { appliedDiscountPct: subject.appliedDiscountPct } : {}),
    scoredAt: new Date(subject.scoredAt).toISOString(),
    graph: buildGraph(assessment, loadDataset()),
    hashscanUrl: subject.hashscanUrl,
    links: subject.links,
  };
}

/** The price is set here, once. Grade D stops the invoice before anything is planned or spent. */
export async function assessForTokenizing(id: string): Promise<Scorecard & { scoredAt: string; hashscanUrl: string }> {
  const { card, subject } = await assessById(id);
  return { ...card, scoredAt: new Date(subject.scoredAt).toISOString(), hashscanUrl: subject.hashscanUrl };
}

/** A simulated invoice shaped like a real one, for GET /invoices. Its grade always comes from the engine. */
export async function seededInvoiceView(id: string) {
  const { subject, card } = await assessById(id);
  const seeded = loadDataset().invoicesById.get(id);
  if (!subject.seeded || !seeded) throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice ${id} not found`);
  const view: Partial<Invoice> & { seeded: true } = {
    id: subject.id,
    seeded: true,
    supplierId: subject.supplierRef,
    supplierName: subject.supplierName,
    buyerId: subject.buyerRef,
    buyerName: subject.buyerName,
    amount: subject.amount,
    issueDate: new Date(seeded.issueDate).toISOString(),
    dueDate: new Date(seeded.dueDate).toISOString(),
    status: "risk_checked",
    grade: card.grade,
    registered: false,
    fingerprint: "",
    hashscanUrl: subject.hashscanUrl,
    links: subject.links,
    amountPaidBy: {},
  };
  return view;
}

/** If the engine is down the demo card is left out, rather than shown with a made-up grade. */
export async function marketplaceDemoInvoice() {
  try {
    return await seededInvoiceView(MARKETPLACE_DEMO_INVOICE);
  } catch {
    return undefined;
  }
}
