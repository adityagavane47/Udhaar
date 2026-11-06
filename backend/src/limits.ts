import type { Request } from "express";
import { rateLimit, type AugmentedRequest } from "express-rate-limit";
import { ApiError } from "./errors.js";

/** Counts per client IP, in memory, so a restart clears them. */
function perIpLimit(windowMinutes: number, limit: number, what: string, skipSuccessfulRequests = false) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    skipSuccessfulRequests,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: Request, _res, next) => {
      const resetTime = (req as AugmentedRequest).rateLimit?.resetTime;
      const retryAfterSeconds = resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : windowMinutes * 60;
      next(new ApiError(429, "RATE_LIMITED", `Too many ${what}. Try again in ${retryAfterSeconds} seconds`, { retryAfterSeconds }));
    },
  });
}

export const limits = {
  /** Shared by every route that spends HBAR, except tokenize. */
  hbar: perIpLimit(1, 20, "requests that spend HBAR"),
  /** Each tokenize deploys a bond for about 10.5 HBAR. */
  tokenize: perIpLimit(10, 5, "tokenize requests"),
  /** Failed attempts only, to slow passcode guessing. */
  login: perIpLimit(15, 10, "failed login attempts", true),
};
