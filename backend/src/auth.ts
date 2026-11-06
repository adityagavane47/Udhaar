import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

/** Made fresh at startup, so restarting the server ends every session. */
const signingKey = randomBytes(32);

type Scope = "admin" | "investor";

/** The scope is signed too, so an admin token can't open investor routes or the other way round. */
const sign = (scope: Scope, expiresAtMs: string) => createHmac("sha256", signingKey).update(`${scope}:${expiresAtMs}`).digest("base64url");

/** Hashing first gives both sides the same length, so the comparison reveals nothing about either. */
function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function issueToken(scope: Scope, minutes: number) {
  const expiresAtMs = String(Date.now() + minutes * 60_000);
  return {
    token: `${expiresAtMs}.${sign(scope, expiresAtMs)}`,
    expiresAt: new Date(Number(expiresAtMs)).toISOString(),
    expiresInSeconds: Math.round(minutes * 60),
  };
}

function requireToken(scope: Scope, description: string, logInAgain: string): RequestHandler {
  const prefix = scope.toUpperCase();
  return (req, _res, next) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!token) throw new ApiError(401, `${prefix}_TOKEN_REQUIRED`, `This route needs ${description}: send Authorization: Bearer <token>`);

    const [expiresAtMs = "", signature = ""] = token.split(".");
    if (!sameText(signature, sign(scope, expiresAtMs))) throw new ApiError(401, `${prefix}_TOKEN_INVALID`, `The ${scope} token is not valid. ${logInAgain}`);
    if (Date.now() >= Number(expiresAtMs)) throw new ApiError(401, `${prefix}_TOKEN_EXPIRED`, `The ${scope} token has expired. ${logInAgain}`);
    next();
  };
}

export const adminPasscodeIsSet = () => Boolean(process.env.DEMO_ADMIN_PASSCODE?.trim());

/** Swaps the demo passcode for a short-lived token. Locked if no passcode is configured. */
export function loginAdmin(passcode: string) {
  if (!adminPasscodeIsSet()) throw new ApiError(503, "ADMIN_AUTH_NOT_CONFIGURED", "Admin login is off: DEMO_ADMIN_PASSCODE is not set on the server");
  if (!sameText(passcode, process.env.DEMO_ADMIN_PASSCODE ?? "")) throw new ApiError(401, "INVALID_PASSCODE", "Invalid passcode");
  return issueToken("admin", config.adminTokenMinutes);
}

export const requireAdmin = requireToken("admin", "an admin token", "Log in again");

/**
 * The demo's investor persona, selected without a passcode. This token says which persona a request
 * is for, but doesn't prove who is asking: anyone who can reach the server can get one. What limits
 * spending is the rate limits, the agent's daily cap and its rules.
 */
export function startInvestorSession() {
  const accountId = process.env.INVESTOR_ID?.trim();
  if (!accountId) throw new ApiError(503, "INVESTOR_NOT_CONFIGURED", "INVESTOR_ID is not set on the server");
  return { ...issueToken("investor", config.investorTokenMinutes), persona: "investor" as const, accountId };
}

export const requireInvestor = requireToken("investor", "an investor session token from POST /auth/demo-investor", "Select the investor again");
