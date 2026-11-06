"use client";
import { useSyncExternalStore } from "react";
import { PERSONAS, type Persona, type Role } from "./types";

const STORAGE_KEY = "udhaar.role";
const ADMIN_TOKEN_KEY = "udhaar.adminToken";
const EVENT_NAME = "udhaar-role-change";

let memoryAdminToken: string | null = null;

const VALID_ROLES = new Set<string>(PERSONAS.map((p) => p.id));

export function readAdminToken(): string | null {
  if (typeof window === "undefined") return memoryAdminToken;
  return window.localStorage.getItem(ADMIN_TOKEN_KEY) ?? memoryAdminToken;
}

export function setAdminToken(token: string | null): void {
  memoryAdminToken = token;
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
  else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export function readStoredRole(): Role | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v && VALID_ROLES.has(v) ? (v as Role) : null;
}

export function setStoredRole(role: Role): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, role);
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function clearStoredRole(): void {
  memoryAdminToken = null;
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(ADMIN_TOKEN_KEY);
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

export function useAuthRole(): { role: Role | null; persona: Persona | null; ready: boolean } {
  const role = useSyncExternalStore(
    subscribe,
    () => readStoredRole() ?? "__none__",
    () => "__ssr__",
  );
  if (role === "__ssr__") return { role: null, persona: null, ready: false };
  if (role === "__none__") return { role: null, persona: null, ready: true };
  const persona = PERSONAS.find((p) => p.id === role) ?? null;
  return { role: role as Role, persona, ready: true };
}
