export interface GraphPerson {
  id: string;
  name: string;
}

/**
 * The fraud checks only touch the graph through this interface, and every method is async, so a
 * Neo4j version can replace the in-memory one without changing the callers.
 */
export interface GraphStore {
  /** Billing loops that an invoice from supplier to buyer would close. Each lists companies in billing order, starting at the supplier. */
  findCycles(supplierId: string, buyerId: string): Promise<string[][]>;
  findSharedDirectors(companyA: string, companyB: string): Promise<GraphPerson[]>;
  /** True if both companies are registered at the same address. */
  findSharedAddress(companyA: string, companyB: string): Promise<boolean>;
  directorsOf(companyId: string): Promise<GraphPerson[]>;
}
