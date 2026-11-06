/**
 * Creates the two extra buyer accounts (Apex Infra Pvt Ltd and Nova Retail) on Hedera testnet and writes
 * their IDs and keys into the root .env. Keys are never printed.
 *
 * Each account is an ECDSA account with an EVM alias, 2 HBAR and room for 10 automatic token
 * associations, paid for by ADMIN (about 4 HBAR in all). The key is written to .env BEFORE anything is
 * sent, so a crash can never strand an account nobody holds the key for. Running it again resumes: a
 * name that already has an ID is skipped, and one with a key but no ID is looked up on the mirror node by
 * its alias before anything is created.
 *
 * Usage: npm run create-buyer-accounts
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { config } from "../src/config.js";
import { getParty } from "../src/hedera/client.js";
import { getAccount, poll } from "../src/hedera/mirror.js";

const ENV_PATH = process.env.ENV_PATH ?? new URL("../../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const BUYERS = [
  { prefix: "APEX", name: "Apex Infra Pvt Ltd" },
  { prefix: "NOVA", name: "Nova Retail" },
] as const;
const INITIAL_HBAR = 2;
const AUTO_ASSOCIATIONS = 10;

if (!existsSync(ENV_PATH)) throw new Error(`No .env at ${ENV_PATH}`);
const envValue = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(ENV_PATH, "utf8"))?.[1]?.trim() || undefined;
const addToEnv = (line: string) => appendFileSync(ENV_PATH, `${readFileSync(ENV_PATH, "utf8").endsWith("\n") ? "" : "\n"}${line}\n`);

const admin = await getParty("ADMIN");
void config;

for (const { prefix, name } of BUYERS) {
  if (envValue(`${prefix}_ID`)) {
    console.log(`${name}: ${prefix}_ID is already set, skipping`);
    continue;
  }

  let rawKey = envValue(`${prefix}_KEY`);
  if (!rawKey) {
    rawKey = PrivateKey.generateECDSA().toStringRaw();
    addToEnv(`${prefix}_KEY=${rawKey}`);
    console.log(`${name}: new key saved to .env as ${prefix}_KEY`);
  }
  const key = PrivateKey.fromStringECDSA(rawKey);
  const evm = `0x${key.publicKey.toEvmAddress()}`;

  // A crash after sending but before the ID was saved leaves the account on-chain: find it by alias.
  let account = await getAccount(evm);
  if (!account) {
    const transaction = new AccountCreateTransaction()
      .setKeyWithAlias(key.publicKey, key)
      .setInitialBalance(new Hbar(INITIAL_HBAR))
      .setMaxAutomaticTokenAssociations(AUTO_ASSOCIATIONS)
      .setAccountMemo(`${name} (demo buyer)`)
      .setMaxTransactionFee(new Hbar(2))
      .freezeWith(admin.client);
    await transaction.sign(key);
    const response = await transaction.execute(admin.client);
    const receipt = await response.getReceipt(admin.client);
    console.log(`${name}: ${receipt.status.toString()}, transaction ${response.transactionId.toString()}`);
    account = await poll(`mirror record of ${name}`, () => getAccount(evm));
  }
  addToEnv(`${prefix}_ID=${account.account}`);
  addToEnv(`${prefix}_EVM=${account.evm_address}`);
  console.log(`${name}: ${account.account} (EVM ${account.evm_address}), ${INITIAL_HBAR} HBAR, ${account.max_automatic_token_associations} automatic associations`);
}
process.exit(0);
