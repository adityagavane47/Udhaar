import type { GraphPerson, GraphStore } from "./graphStore.js";

const MAX_CYCLE_LENGTH = 6;
const MAX_CYCLES = 5;

const normalizeAddress = (address: string) => address.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface GraphData {
  companies: { id: string; address: string }[];
  directors: { id: string; name: string; companyIds: string[] }[];
  invoices: { supplierId: string; buyerId: string }[];
}

export class InMemoryGraphStore implements GraphStore {
  private readonly billsTo = new Map<string, Set<string>>();
  private readonly addressOf = new Map<string, string>();
  private readonly directorsByCompany = new Map<string, GraphPerson[]>();

  constructor(data: GraphData) {
    for (const invoice of data.invoices) {
      const targets = this.billsTo.get(invoice.supplierId) ?? new Set<string>();
      targets.add(invoice.buyerId);
      this.billsTo.set(invoice.supplierId, targets);
    }
    for (const company of data.companies) this.addressOf.set(company.id, normalizeAddress(company.address));
    for (const director of data.directors) {
      for (const companyId of director.companyIds) {
        const people = this.directorsByCompany.get(companyId) ?? [];
        people.push({ id: director.id, name: director.name });
        this.directorsByCompany.set(companyId, people);
      }
    }
  }

  /** The invoice is the edge supplier -> buyer, so any path from the buyer back to the supplier closes a loop. */
  async findCycles(supplierId: string, buyerId: string): Promise<string[][]> {
    const cycles: string[][] = [];
    const walk = (current: string, path: string[]) => {
      if (cycles.length >= MAX_CYCLES) return;
      if (path.length > MAX_CYCLE_LENGTH) return;
      for (const next of this.billsTo.get(current) ?? []) {
        if (next === supplierId) cycles.push(path);
        else if (!path.includes(next)) walk(next, [...path, next]);
      }
    };
    if (supplierId !== buyerId) walk(buyerId, [supplierId, buyerId]);
    return cycles;
  }

  async findSharedDirectors(companyA: string, companyB: string): Promise<GraphPerson[]> {
    const other = new Set((this.directorsByCompany.get(companyB) ?? []).map((person) => person.id));
    return (this.directorsByCompany.get(companyA) ?? []).filter((person) => other.has(person.id));
  }

  async findSharedAddress(companyA: string, companyB: string): Promise<boolean> {
    const address = this.addressOf.get(companyA);
    return address !== undefined && address === this.addressOf.get(companyB);
  }

  async directorsOf(companyId: string): Promise<GraphPerson[]> {
    return this.directorsByCompany.get(companyId) ?? [];
  }
}
