/**
 * Puts a backup made by demo:reset back over the data directory. The current state is backed up first.
 * Stop the backend first, then restart it.
 *
 * Usage: npm run demo:restore <backup path or folder name under data/backups>
 */
import { config } from "../src/config.js";
import { restoreBackup, serverIsRunning } from "../src/demo/reset.js";

const name = process.argv[2];
if (!name) {
  console.error("Usage: npm run demo:restore <backup path or folder name under data/backups>");
  process.exit(1);
}
if (await serverIsRunning(config.port)) {
  console.error(`The backend is running on port ${config.port}. Stop it first.`);
  process.exit(1);
}
let result: ReturnType<typeof restoreBackup>;
try {
  result = restoreBackup(config.dataDir, name);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Restore failed");
  process.exit(1);
}
const { restoredFrom, safetyBackup } = result;
console.log(`Restored ${config.dataDir}\n  from ${restoredFrom}\nThe state before the restore was saved to ${safetyBackup}\nRestart the backend to load it.`);
