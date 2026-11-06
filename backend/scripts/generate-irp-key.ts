/**
 * Creates the MOCK IRP signing key pair. The private key is written to MOCK_IRP_PRIVATE_KEY in the
 * root .env and is never printed. The public key goes to deployments/mock-irp-public.json.
 *
 * Safe to rerun: an existing key is never replaced. Delete the .env line and the public file to rotate.
 *
 * Usage: npm run generate-irp-key
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PUBLIC_KEY_PATH } from "../src/trust/irp.js";

const ENV_PATH = process.env.ENV_PATH ?? fileURLToPath(new URL("../../.env", import.meta.url));
const KEY_NAME = "MOCK_IRP_PRIVATE_KEY";

const envText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
const existing = new RegExp(`^${KEY_NAME}=(.+)$`, "m").exec(envText)?.[1]?.trim();

function publicRecord(privateDer: Buffer) {
  const jwk = createPublicKey(createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" })).export({ format: "jwk" });
  // The key ID is a thumbprint of the public key, so it changes if and only if the key does.
  const kid = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("hex").slice(0, 16);
  return {
    source: "mock",
    notice: "MOCK IRP public key. It verifies signed QRs made by this project's mock e-invoice signer, not real ones from the Indian IRP.",
    alg: "ES256",
    kid,
    jwk,
  };
}

if (existing) {
  if (existsSync(PUBLIC_KEY_PATH)) {
    console.log(`${KEY_NAME} is already set and the public key exists. Nothing changed.`);
  } else {
    writeFileSync(PUBLIC_KEY_PATH, `${JSON.stringify(publicRecord(Buffer.from(existing, "base64")), null, 2)}\n`);
    console.log(`${KEY_NAME} was already set. Rebuilt the public key at deployments/mock-irp-public.json from it.`);
  }
} else {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  writeFileSync(ENV_PATH, `${envText}${envText === "" || envText.endsWith("\n") ? "" : "\n"}${KEY_NAME}=${der.toString("base64")}\n`);
  writeFileSync(PUBLIC_KEY_PATH, `${JSON.stringify(publicRecord(der), null, 2)}\n`);
  console.log(`Created a mock IRP key pair. The private key was added to .env as ${KEY_NAME} (not shown). The public key is at deployments/mock-irp-public.json.`);
}
