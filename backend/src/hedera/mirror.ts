import { config } from "../config.js";

export interface MirrorTransaction {
  transaction_id: string;
  consensus_timestamp: string;
  charged_tx_fee: number;
  entity_id?: string | null;
  memo_base64: string;
  name: string;
  nonce: number;
  result: string;
  token_transfers?: { account: string; amount: number; token_id: string }[];
  assessed_custom_fees?: { amount: number; collector_account_id: string }[];
}

export interface MirrorAccount {
  account: string;
  evm_address: string;
  key: { _type: string; key: string } | null;
  balance: { balance: number };
  deleted?: boolean;
  max_automatic_token_associations: number;
  receiver_sig_required: boolean;
}

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2_000;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function mirrorGet<T>(path: string): Promise<T | undefined> {
  const response = await fetch(`${config.mirrorUrl}${path}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Mirror node returned ${response.status} for ${path}`);
  return (await response.json()) as T;
}

/** Retries until `attempt` returns a value. Mirror state lags consensus by a few seconds. */
export async function poll<T>(description: string, attempt: () => Promise<T | undefined>, attempts = POLL_ATTEMPTS): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = await attempt();
    if (value !== undefined) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Follows every page. Throws if the walk cannot finish, so a partial history is never read as complete. */
export async function* mirrorPages<T>(path: string, field: string, maxPages = 200): AsyncGenerator<T> {
  let next: string | null = path;
  for (let page = 0; next; page++) {
    if (page >= maxPages) throw new Error(`Mirror history at ${path} did not finish`);
    const body: (Record<string, T[]> & { links?: { next: string | null } }) | undefined = await mirrorGet(next);
    if (!body) throw new Error(`Mirror history at ${next} was not found`);
    for (const item of body[field] ?? []) yield item;
    const link: string | null | undefined = body.links?.next;
    next = link ? link.replace(/^\/api\/v1/, "") : null;
  }
}

export function toMirrorTransactionId(id: string) {
  if (!id.includes("@")) return id;
  const [account = "", timestamp = ""] = id.split("@");
  const [seconds = "", nanos = ""] = timestamp.split(".");
  return `${account}-${seconds}-${nanos.padStart(9, "0")}`;
}

export async function findTransaction(id: string) {
  const found = await mirrorGet<{ transactions: MirrorTransaction[] }>(`/transactions/${toMirrorTransactionId(id)}`);
  return found?.transactions.find((entry) => entry.nonce === 0);
}

/** Waits until the mirror node has indexed past `seconds`, so reads and searches cannot miss earlier work. */
export async function waitForMirrorToReach(seconds = Math.floor(Date.now() / 1000)) {
  await poll("the mirror node to catch up", async () => {
    const latest = await mirrorGet<{ transactions: MirrorTransaction[] }>("/transactions?limit=1&order=desc");
    return Number(latest?.transactions[0]?.consensus_timestamp ?? 0) >= seconds ? true : undefined;
  });
}

export const getAccount = (idOrEvm: string) => mirrorGet<MirrorAccount>(`/accounts/${idOrEvm}`);

let cachedGasPrice: { value: number; at: number } | undefined;

/** Tinybar per gas for contract calls. Cached for 5 minutes. */
export async function gasPriceTinybar(): Promise<number> {
  if (cachedGasPrice && Date.now() - cachedGasPrice.at < 300_000) return cachedGasPrice.value;
  const fees = await mirrorGet<{ fees: { gas: number; transaction_type: string }[] }>("/network/fees");
  const value = fees?.fees.find((fee) => fee.transaction_type === "ContractCall")?.gas;
  if (!value) throw new Error("Mirror node did not report a contract gas price");
  cachedGasPrice = { value, at: Date.now() };
  return value;
}
