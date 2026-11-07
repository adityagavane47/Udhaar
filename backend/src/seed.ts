import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/**
 * On a fresh deployment (an empty volume), copies backend/seed/store.json into DATA_DIR so the demo
 * starts with its invoices and history. It never overwrites a store that is already there.
 * Imported first by server.ts, so it runs before the store is read. Tests don't import it.
 */
export function seedStoreIfMissing(): "seeded" | "existing" | "no-seed" {
  const target = `${config.dataDir.replace(/[\/]$/, "")}/store.json`;
  if (existsSync(target)) return "existing";
  if (!existsSync(config.seedStorePath)) return "no-seed";
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(config.seedStorePath, target, 1); // 1 = COPYFILE_EXCL: fails rather than overwrite
  return "seeded";
}

export const seedResult = seedStoreIfMissing();
if (seedResult === "seeded") console.log(`Fresh data directory: copied the seed store into ${config.dataDir}`);
