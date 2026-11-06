import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

/** Made fresh at startup, so restarting the server signs the admin out. */
const signingKey = randomBytes(32);

const sign = (expiresAtMs: string) => createHmac("sha256", signingKey).update(expiresAtMs).digest("base64url");

/** Hashing first gives both sides the same length, so the comparison reveals nothing about either. */
function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export const adminPasscodeIsSet = () => Boolean(process.env.DEMO_ADMIN_PASSCODE?.trim());

/** Swaps the demo passcode for a short-lived token. Locked if no passcode is configured. */
export function loginAdmin(passcode: string) {
  if (!adminPasscodeIsSet()) throw new ApiError(503, "ADMIN_AUTH_NOT_CONFIGURED", "Admin login is off: DEMO_ADMIN_PASSCODE is not set on the server");
  if (!sameText(passcode, process.env.DEMO_ADMIN_PASSCODE ?? "")) throw new ApiError(401, "INVALID_PASSCODE", "Invalid passcode");

  const expiresAtMs = String(Date.now() + config.adminTokenMinutes * 60_000);
  return {
    token: `${expiresAtMs}.${sign(expiresAtMs)}`,
    expiresAt: new Date(Number(expiresAtMs)).toISOString(),
    expiresInSeconds: Math.round(config.adminTokenMinutes * 60),
  };
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!token) throw new ApiError(401, "ADMIN_TOKEN_REQUIRED", "This route needs an admin token: send Authorization: Bearer <token>");

  const [expiresAtMs = "", signature = ""] = token.split(".");
  if (!sameText(signature, sign(expiresAtMs))) throw new ApiError(401, "ADMIN_TOKEN_INVALID", "The admin token is not valid. Log in again");
  if (Date.now() >= Number(expiresAtMs)) throw new ApiError(401, "ADMIN_TOKEN_EXPIRED", "The admin token has expired. Log in again");
  next();
};
