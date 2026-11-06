"use client";
import { useSyncExternalStore } from "react";
import { PERSONAS, type InvestorSession, type Persona, type Role } from "./types";

const STORAGE_KEY = "udhaar.role";
const ADMIN_SESSION_KEY = "udhaar.adminSession";
const LEGACY_ADMIN_TOKEN_KEY = "udhaar.adminToken";
const INVESTOR_SESSION_KEY = "udhaar.investorSession";
const EVENT_NAME = "udhaar-role-change";

export interface AdminSession {
  token: string;
  expiresAt: string;
}

let memoryAdminSession: AdminSession | null = null;
let memoryInvestorSession: InvestorSession | null = null;

const VALID_ROLES = new Set<string>(PERSONAS.map((p) => p.id));

function parseAdminSession(raw: string | null): AdminSession | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as AdminSession;
    if (p && typeof p.token === "string" && typeof p.expiresAt === "string") return p;
  } catch {
    /* ignore damaged storage */
  }
  return null;
}

/** Reads the stored admin session from localStorage (or memory fallback). */
export function readAdminSession(): AdminSession | null {
  if (typeof window === "undefined") return memoryAdminSession;
  window.localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY);
  const fromStorage = parseAdminSession(window.localStorage.getItem(ADMIN_SESSION_KEY));
  if (fromStorage) {
    memoryAdminSession = fromStorage;
    return fromStorage;
  }
  return memoryAdminSession;
}

/** True only when an admin token exists and its expiresAt timestamp is in the future. */
export function isAdminSessionValid(session: AdminSession | null = readAdminSession()): boolean {
  if (!session?.token || !session.expiresAt) return false;
  const exp = Date.parse(session.expiresAt);
  return Number.isFinite(exp) && exp > Date.now();
}

/** Returns the admin bearer token only while it exists and has not expired. */
export function readAdminToken(): string | null {
  const s = readAdminSession();
  if (!isAdminSessionValid(s)) return null;
  return s!.token;
}

export function setAdminSession(session: AdminSession): void {
  memoryAdminSession = session;
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function clearAdminSession(): void {
  memoryAdminSession = null;
  if (typeof window === "undefined") return;
  const hadSession = window.localStorage.getItem(ADMIN_SESSION_KEY) !== null;
  const hadRole = window.localStorage.getItem(STORAGE_KEY) === "admin";
  window.localStorage.removeItem(ADMIN_SESSION_KEY);
  window.localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY);
  if (hadRole) window.localStorage.removeItem(STORAGE_KEY);
  if (hadSession || hadRole) window.dispatchEvent(new Event(EVENT_NAME));
}

/** True only when the active persona is admin AND a non-expired admin token is present. */
export function hasAdminAccess(): boolean {
  return readStoredRole() === "admin" && isAdminSessionValid();
}

export function readInvestorSession(): InvestorSession | null {
  if (typeof window === "undefined") return memoryInvestorSession;
  const raw = window.localStorage.getItem(INVESTOR_SESSION_KEY);
  if (!raw) return memoryInvestorSession;
  try {
    const parsed = JSON.parse(raw) as InvestorSession;
    if (parsed && typeof parsed.token === "string" && typeof parsed.expiresAt === "string") {
      return parsed;
    }
  } catch {
    /* ignore damaged storage */
  }
  return memoryInvestorSession;
}

export function setInvestorSession(session: InvestorSession | null): void {
  memoryInvestorSession = session;
  if (typeof window === "undefined") return;
  if (session) window.localStorage.setItem(INVESTOR_SESSION_KEY, JSON.stringify(session));
  else window.localStorage.removeItem(INVESTOR_SESSION_KEY);
}

/** True when the investor token exists and is at least 5 seconds away from expiring. */
export function isInvestorSessionFresh(
  session: InvestorSession | null = readInvestorSession(),
): session is InvestorSession {
  if (!session?.token || !session.expiresAt) return false;
  const exp = Date.parse(session.expiresAt);
  return Number.isFinite(exp) && exp - 5_000 > Date.now();
}

export function readStoredRole(): Role | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v && VALID_ROLES.has(v) ? (v as Role) : null;
}

export function setStoredRole(role: Role): void {
  if (typeof window === "undefined") return;
  // A stored admin token must never carry over to Business, Buyer, or Investor.
  if (role !== "admin") {
    memoryAdminSession = null;
    window.localStorage.removeItem(ADMIN_SESSION_KEY);
    window.localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY);
  }
  window.localStorage.setItem(STORAGE_KEY, role);
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function clearStoredRole(): void {
  memoryAdminSession = null;
  memoryInvestorSession = null;
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(ADMIN_SESSION_KEY);
  window.localStorage.removeItem(LEGACY_ADMIN_TOKEN_KEY);
  window.localStorage.removeItem(INVESTOR_SESSION_KEY);
  window.dispatchEvent(new Event(EVENT_NAME));
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener("storage", handler);
  window.addEventListener(EVENT_NAME, handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener(EVENT_NAME, handler);
  };
}

function readSnapshot(): string {
  const role = readStoredRole() ?? "";
  const s = readAdminSession();
  const validAdmin = isAdminSessionValid(s);
  return `${role}|${validAdmin ? s?.expiresAt ?? "1" : "0"}`;
}

export function useAuthRole(): {
  role: Role | null;
  persona: Persona | null;
  adminValid: boolean;
  adminExpiresAt: string | null;
  ready: boolean;
} {
  const snap = useSyncExternalStore(subscribe, readSnapshot, () => "__ssr__");
  if (snap === "__ssr__") {
    return {
      role: null,
      persona: null,
      adminValid: false,
      adminExpiresAt: null,
      ready: false,
    };
  }
  const [rawRole, adminPart] = snap.split("|");
  const adminValid = adminPart !== "0";
  // An "admin" role in storage without a live token is not an authenticated persona.
  const effectiveRole =
    !rawRole || (rawRole === "admin" && !adminValid) ? null : (rawRole as Role);
  const persona = effectiveRole ? (PERSONAS.find((p) => p.id === effectiveRole) ?? null) : null;
  return {
    role: effectiveRole,
    persona,
    adminValid,
    adminExpiresAt: adminValid ? adminPart : null,
    ready: true,
  };
}
