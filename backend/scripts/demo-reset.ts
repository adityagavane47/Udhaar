/**
 * Resets the demo for a clean recording. Sends no Hedera transactions and never deletes anything.
 *
 *  1. Backs up the whole data directory to data/backups/<timestamp>.
 *  2. Archives every invoice, agent run and audit entry (hidden from lists, still found by ID).
 *  3. Makes the next invoice INV-0042, or the next free number if INV-0042 or higher is already used.
 *  4. Sets the investor's app-level KYC back to "pending".
 *
 * Stop the backend first, then restart it. Undo with: npm run demo:restore <backup>
 *
 * Usage: npm run demo:reset
 */
import { config } from "../src/config.js";
import { archiveStore, backupDataDir, readStore, serverIsRunning, writeStore } from "../src/demo/reset.js";

const dataDir = config.dataDir;
if (await serverIsRunning(config.port)) {
  console.error(`The backend is running on port ${config.port}. Stop it first: it would overwrite the reset the next time it saves.`);
  process.exit(1);
}

const before = readStore(dataDir);
const backup = backupDataDir(dataDir);
console.log(`Backup of ${dataDir}\n  -> ${backup}`);

const { store, summary } = archiveStore(before, { investorAccountId: process.env.INVESTOR_ID?.trim() });
writeStore(dataDir, store);

const { archived, alreadyArchived } = summary;
console.log(`Archived ${archived.invoices} invoices, ${archived.agentRuns} agent runs, ${archived.auditEntries} audit entries (${alreadyArchived.invoices + alreadyArchived.agentRuns + alreadyArchived.auditEntries} were already archived).`);
console.log(summary.kyc ? `KYC ${summary.kyc.id} for ${summary.kyc.walletAddress}: ${summary.kyc.before} -> pending` : "No KYC request found for INVESTOR_ID, so none was changed.");
console.log(`Next invoice: ${summary.nextInvoiceId}`);
if (summary.raisedBecause) console.log(`Note: ${summary.raisedBecause}`);
console.log(`Restart the backend to load it. To undo: npm run demo:restore ${backup}`);
