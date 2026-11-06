"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DAppConnector,
  HederaChainId,
  HederaJsonRpcMethod,
  HederaSessionEvent,
  extensionQuery,
  type ExtensionData,
} from "@hashgraph/hedera-wallet-connect";
import { LedgerId } from "@hiero-ledger/sdk";
import type { SessionTypes } from "@walletconnect/types";
import { Loader2, RefreshCw, Unplug, Wallet } from "lucide-react";
import { ErrorNote, HashscanLink, StampBadge } from "@/components/common";
import { getTokenCatalog } from "@/lib/api";
import type { BondTokenMeta } from "@/lib/types";
import { inr, inrPrice } from "@/lib/utils";

const PROJECT_ID = (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "").trim();
const MIRROR_BASE = "https://testnet.mirrornode.hedera.com/api/v1";
const READ_ONLY_NOTE =
  "Read-only for now. Demo trades are signed by pre-funded testnet personas; wallet signing is next.";

interface MirrorAccountResponse {
  account?: string;
  balance?: {
    balance?: number;
    timestamp?: string;
    tokens?: { token_id: string; balance: number }[];
  };
}

interface MirrorTokensResponse {
  tokens?: {
    token_id: string;
    balance: number;
    decimals?: number;
  }[];
}

export interface HeldBond extends BondTokenMeta {
  units: number;
}

export interface WalletBalances {
  hbar: number;
  uinr: number;
  uinrTokenId: string | null;
  bonds: HeldBond[];
  totalBondUnits: number;
  fetchedAt: string;
}

type WalletErrorKind =
  | "not_installed"
  | "pairing_rejected"
  | "session_expired"
  | "wrong_network"
  | "mirror_error"
  | "generic";

interface WalletErrorState {
  kind: WalletErrorKind;
  title: string;
  message: string;
}

/** Module-level singleton so DAppConnector is initialized at most once in the browser. */
let connectorInstance: DAppConnector | null = null;
let connectorInitPromise: Promise<DAppConnector> | null = null;

function initConnectorOnce(projectId: string): Promise<DAppConnector> {
  if (connectorInstance) return Promise.resolve(connectorInstance);
  if (connectorInitPromise) return connectorInitPromise;

  connectorInitPromise = (async () => {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://udhaar.local";

    const metadata = {
      name: "Udhaar — Bahi-Khata On-Chain",
      description: "MSME invoice financing on Hedera Testnet",
      url: origin,
      icons: [`${origin}/favicon.ico`],
    };

    const dAppConnector = new DAppConnector(
      metadata,
      LedgerId.TESTNET,
      projectId,
      Object.values(HederaJsonRpcMethod),
      [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
      [HederaChainId.Testnet],
    );

    await dAppConnector.init({ logger: "error" });
    if (!dAppConnector.walletConnectClient) {
      throw new Error("WalletConnect client failed to initialize.");
    }
    connectorInstance = dAppConnector;
    return dAppConnector;
  })().catch((err) => {
    connectorInitPromise = null;
    connectorInstance = null;
    throw err;
  });

  return connectorInitPromise;
}

function findHashPackExtension(connector: DAppConnector): ExtensionData | undefined {
  const available = (connector.extensions ?? []).filter((ext) => ext.available);
  return (
    available.find((ext) => /hashpack/i.test(ext.name ?? "")) ??
    available[0]
  );
}

type SessionParseResult =
  | { ok: true; topic: string; accountId: string; expiry?: number }
  | { ok: false; reason: "expired" | "wrong_network"; detail?: string };

function parseHederaSession(
  session: SessionTypes.Struct,
  connector: DAppConnector,
): SessionParseResult {
  if (typeof session.expiry === "number" && session.expiry * 1000 <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const namespaces = session.namespaces ?? {};
  const hederaNs = namespaces.hedera;
  const allAccounts: string[] = [];
  const allChains: string[] = [];

  for (const [nsKey, nsVal] of Object.entries(namespaces)) {
    if (Array.isArray(nsVal?.accounts)) {
      allAccounts.push(...nsVal.accounts);
    }
    if (Array.isArray(nsVal?.chains)) {
      allChains.push(...nsVal.chains);
    }
    if (nsKey !== "hedera") {
      return { ok: false, reason: "wrong_network", detail: nsKey };
    }
  }

  for (const chain of allChains) {
    if (chain.toLowerCase() !== HederaChainId.Testnet) {
      return { ok: false, reason: "wrong_network", detail: chain };
    }
  }

  const hederaAccounts = hederaNs?.accounts ?? allAccounts;
  for (const raw of hederaAccounts) {
    const parts = raw.split(":");
    if (parts.length === 3) {
      const [ns, net, acc] = parts;
      if (ns.toLowerCase() !== "hedera" || net.toLowerCase() !== "testnet") {
        return { ok: false, reason: "wrong_network", detail: `${ns}:${net}` };
      }
      if (/^0\.0\.\d+$/.test(acc)) {
        return { ok: true, topic: session.topic, accountId: acc, expiry: session.expiry };
      }
    }
  }

  const signerForTopic = (connector.signers ?? []).find((s) => s.topic === session.topic);
  if (signerForTopic) {
    const ledger = signerForTopic.getLedgerId?.()?.toString?.()?.toLowerCase?.() ?? "";
    const acc = signerForTopic.getAccountId?.()?.toString?.() ?? "";
    if (ledger && ledger !== "testnet") {
      return { ok: false, reason: "wrong_network", detail: ledger };
    }
    if (/^0\.0\.\d+$/.test(acc)) {
      return { ok: true, topic: session.topic, accountId: acc, expiry: session.expiry };
    }
  }

  return { ok: false, reason: "wrong_network" };
}

function classifyWalletError(err: unknown): WalletErrorState {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : typeof (err as { message?: unknown })?.message === "string"
          ? String((err as { message: string }).message)
          : "Wallet connection failed";

  const code = (err as { code?: number })?.code;

  if (/extension is not available|hashpack not installed|no extension/i.test(raw)) {
    return {
      kind: "not_installed",
      title: "HASHPACK NOT INSTALLED",
      message:
        "HashPack browser extension was not detected. Install the HashPack extension for Chrome/Brave, or click “Pair via QR / Modal” to connect with a pairing code.",
    };
  }

  if (
    code === 4001 ||
    code === 5000 ||
    code === 5001 ||
    /user rejected|rejected|declined|denied|cancelled|canceled|modal closed|disapproved/i.test(raw)
  ) {
    return {
      kind: "pairing_rejected",
      title: "PAIRING REJECTED",
      message: "Pairing rejected — the connection request was declined or closed before completion.",
    };
  }

  if (/expired|session topic doesn't exist|no matching key/i.test(raw)) {
    return {
      kind: "session_expired",
      title: "SESSION EXPIRED",
      message: "Your HashPack session expired. Please reconnect your wallet.",
    };
  }

  if (/wrong network|mainnet|previewnet|unsupported chain|namespace/i.test(raw)) {
    return {
      kind: "wrong_network",
      title: "WRONG NETWORK",
      message: "Wrong network — switch HashPack to Hedera Testnet (hedera:testnet) and try again.",
    };
  }

  return {
    kind: "generic",
    title: "WALLET ERROR",
    message: raw,
  };
}

async function fetchMirrorBalances(accountId: string): Promise<WalletBalances> {
  const encodedId = encodeURIComponent(accountId);
  const [acctRes, tokRes, catalog] = await Promise.all([
    fetch(`${MIRROR_BASE}/accounts/${encodedId}`, { cache: "no-store" }),
    fetch(`${MIRROR_BASE}/accounts/${encodedId}/tokens?limit=100`, { cache: "no-store" }),
    getTokenCatalog(),
  ]);

  if (acctRes.status === 404) {
    throw new Error(
      `Account ${accountId} was not found on Hedera Testnet. Make sure your HashPack wallet is set to Testnet.`,
    );
  }
  if (!acctRes.ok) {
    throw new Error(`Mirror node account lookup failed (${acctRes.status}).`);
  }

  const acctData = (await acctRes.json()) as MirrorAccountResponse;
  const tokData: MirrorTokensResponse = tokRes.ok
    ? ((await tokRes.json()) as MirrorTokensResponse)
    : { tokens: [] };

  const tinybars = Number(acctData.balance?.balance ?? 0);
  const hbar = Number.isFinite(tinybars) ? tinybars / 1e8 : 0;

  const tokenBalances = new Map<string, { balance: number; decimals?: number }>();
  for (const t of acctData.balance?.tokens ?? []) {
    if (t?.token_id) {
      tokenBalances.set(t.token_id, { balance: Number(t.balance ?? 0) });
    }
  }
  for (const t of tokData.tokens ?? []) {
    if (t?.token_id) {
      tokenBalances.set(t.token_id, {
        balance: Number(t.balance ?? 0),
        decimals: typeof t.decimals === "number" ? t.decimals : undefined,
      });
    }
  }

  let uinr = 0;
  if (catalog.uinrTokenId) {
    const entry = tokenBalances.get(catalog.uinrTokenId);
    if (entry && Number.isFinite(entry.balance)) {
      const decimals = entry.decimals ?? 2;
      uinr = entry.balance / 10 ** decimals;
    }
  }

  const heldBonds: HeldBond[] = [];
  for (const bond of catalog.bonds) {
    const mirrorEntry = tokenBalances.get(bond.tokenId);
    const mirrorUnits = mirrorEntry?.balance ?? 0;
    const holderUnits =
      bond.holders?.find((h) => h.accountId === accountId)?.units ?? 0;
    const units = mirrorUnits > 0 ? mirrorUnits : holderUnits;
    if (units > 0) {
      heldBonds.push({ ...bond, units });
    }
  }

  const totalBondUnits = heldBonds.reduce((sum, b) => sum + b.units, 0);

  return {
    hbar,
    uinr,
    uinrTokenId: catalog.uinrTokenId,
    bonds: heldBonds,
    totalBondUnits,
    fetchedAt: new Date().toISOString(),
  };
}

export function WalletPanel() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [sessionTopic, setSessionTopic] = useState<string | null>(null);
  const [sessionExpiry, setSessionExpiry] = useState<number | null>(null);
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [connectingMode, setConnectingMode] = useState<"extension" | "modal" | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [walletErr, setWalletErr] = useState<WalletErrorState | null>(null);
  const activeTopicRef = useRef<string | null>(null);

  useEffect(() => {
    activeTopicRef.current = sessionTopic;
  }, [sessionTopic]);

  const loadAccountBalances = useCallback(async (acctId: string) => {
    setLoadingBalances(true);
    try {
      const data = await fetchMirrorBalances(acctId);
      setBalances(data);
    } catch (err) {
      setWalletErr({
        kind: "mirror_error",
        title: "MIRROR NODE ERROR",
        message: err instanceof Error ? err.message : "Failed to load balances from Hedera Mirror Node.",
      });
    } finally {
      setLoadingBalances(false);
    }
  }, []);

  const clearConnectedState = useCallback(() => {
    setAccountId(null);
    setSessionTopic(null);
    setSessionExpiry(null);
    setBalances(null);
  }, []);

  const applySession = useCallback(
    async (session: SessionTypes.Struct, connector: DAppConnector) => {
      const parsed = parseHederaSession(session, connector);
      if (!parsed.ok) {
        try {
          await connector.disconnect(session.topic);
        } catch {
          /* ignore */
        }
        clearConnectedState();
        if (parsed.reason === "expired") {
          setWalletErr({
            kind: "session_expired",
            title: "SESSION EXPIRED",
            message: "Your HashPack session expired. Please reconnect your wallet.",
          });
        } else {
          setWalletErr({
            kind: "wrong_network",
            title: "WRONG NETWORK",
            message: `Wrong network${parsed.detail ? ` (${parsed.detail})` : ""} — switch HashPack to Hedera Testnet (hedera:testnet) and reconnect.`,
          });
        }
        return;
      }

      setWalletErr(null);
      setAccountId(parsed.accountId);
      setSessionTopic(parsed.topic);
      setSessionExpiry(parsed.expiry ?? null);
      await loadAccountBalances(parsed.accountId);
    },
    [clearConnectedState, loadAccountBalances],
  );

  // Initialize DAppConnector once on mount & subscribe to session lifecycle events
  useEffect(() => {
    if (!PROJECT_ID) return;
    let cancelled = false;
    let cleanupListeners: (() => void) | undefined;

    void (async () => {
      try {
        const connector = await initConnectorOnce(PROJECT_ID);
        if (cancelled) return;

        const wcClient = connector.walletConnectClient;
        if (wcClient) {
          const onExpire = (event: { topic: string }) => {
            if (cancelled) return;
            if (!activeTopicRef.current || event.topic === activeTopicRef.current) {
              clearConnectedState();
              setWalletErr({
                kind: "session_expired",
                title: "SESSION EXPIRED",
                message: "Your HashPack session expired. Please reconnect your wallet.",
              });
            }
          };

          const onDelete = (event: { topic: string }) => {
            if (cancelled) return;
            if (!activeTopicRef.current || event.topic === activeTopicRef.current) {
              clearConnectedState();
              setWalletErr({
                kind: "session_expired",
                title: "SESSION ENDED",
                message: "Session expired or disconnected from HashPack. Reconnect when ready.",
              });
            }
          };

          const onUpdate = ({
            topic,
            params,
          }: {
            topic: string;
            params: { namespaces: SessionTypes.Namespaces };
          }) => {
            if (cancelled) return;
            try {
              const base = wcClient.session.get(topic);
              const updated: SessionTypes.Struct = { ...base, namespaces: params.namespaces };
              void applySession(updated, connector);
            } catch {
              /* ignore */
            }
          };

          const onEvent = (args: {
            topic: string;
            params?: { chainId?: string; event?: { name?: string; data?: unknown } };
          }) => {
            if (cancelled) return;
            const chainId = args?.params?.chainId;
            if (chainId && chainId.toLowerCase() !== HederaChainId.Testnet) {
              void connector.disconnect(args.topic).catch(() => {});
              clearConnectedState();
              setWalletErr({
                kind: "wrong_network",
                title: "WRONG NETWORK",
                message: `Wrong network (${chainId}) — switch HashPack to Hedera Testnet (hedera:testnet).`,
              });
              return;
            }
            try {
              const current = wcClient.session.get(args.topic);
              if (current) void applySession(current, connector);
            } catch {
              /* ignore */
            }
          };

          wcClient.on("session_expire", onExpire);
          wcClient.on("session_delete", onDelete);
          wcClient.on("session_update", onUpdate);
          wcClient.on("session_event", onEvent);

          cleanupListeners = () => {
            wcClient.off?.("session_expire", onExpire);
            wcClient.off?.("session_delete", onDelete);
            wcClient.off?.("session_update", onUpdate);
            wcClient.off?.("session_event", onEvent);
          };

          const existingSessions = wcClient.session.getAll();
          if (existingSessions.length > 0) {
            const latest = existingSessions[existingSessions.length - 1];
            await applySession(latest, connector);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setWalletErr(classifyWalletError(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanupListeners?.();
    };
  }, [applySession, clearConnectedState]);

  // Periodically check active session expiry so expired sessions are caught cleanly
  useEffect(() => {
    if (!sessionExpiry || !sessionTopic) return;
    const timer = setInterval(() => {
      if (sessionExpiry * 1000 <= Date.now()) {
        if (connectorInstance) {
          void connectorInstance.disconnect(sessionTopic).catch(() => {});
        }
        clearConnectedState();
        setWalletErr({
          kind: "session_expired",
          title: "SESSION EXPIRED",
          message: "Your HashPack session expired. Please reconnect your wallet.",
        });
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [clearConnectedState, sessionExpiry, sessionTopic]);

  async function handleConnectHashPack() {
    if (!PROJECT_ID || connectingMode) return;
    setWalletErr(null);
    setConnectingMode("extension");

    try {
      const connector = await initConnectorOnce(PROJECT_ID);
      let ext = findHashPackExtension(connector);
      if (!ext) {
        extensionQuery();
        await new Promise((r) => setTimeout(r, 300));
        ext = findHashPackExtension(connector);
      }

      if (!ext) {
        setWalletErr({
          kind: "not_installed",
          title: "HASHPACK NOT INSTALLED",
          message:
            "HashPack browser extension was not detected. Install the HashPack extension for Chrome/Brave, or click “Pair via QR / Modal” to connect with a WalletConnect code.",
        });
        return;
      }

      const session = await connector.connectExtension(ext.id);
      await applySession(session, connector);
    } catch (err) {
      setWalletErr(classifyWalletError(err));
    } finally {
      setConnectingMode(null);
    }
  }

  async function handleConnectModal() {
    if (!PROJECT_ID || connectingMode) return;
    setWalletErr(null);
    setConnectingMode("modal");

    try {
      const connector = await initConnectorOnce(PROJECT_ID);
      const session = await connector.openModal(undefined, true);
      await applySession(session, connector);
    } catch (err) {
      setWalletErr(classifyWalletError(err));
    } finally {
      setConnectingMode(null);
    }
  }

  async function handleDisconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    setWalletErr(null);
    try {
      if (connectorInstance) {
        if (sessionTopic) {
          await connectorInstance.disconnect(sessionTopic).catch(() => {});
        }
        await connectorInstance.disconnectAll().catch(() => {});
      }
    } finally {
      clearConnectedState();
      setDisconnecting(false);
    }
  }

  const hashscanAccountUrl = accountId
    ? `https://hashscan.io/testnet/account/${accountId}`
    : undefined;

  return (
    <section className="border-2 border-[#1B2340] bg-[#FBF6EA] p-6 shadow-[6px_6px_0_#1B2340] sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="space-y-2">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E]">
            PANEL 01 · WALLET SIGNER
          </span>
          <h2 className="m-0 font-serif text-3xl font-normal text-[#1B2340] sm:text-4xl">
            Connect your wallet
          </h2>
          <p className="m-0 max-w-xl text-base leading-[1.6] text-[#5A5E78]">
            Pair your HashPack wallet on Hedera testnet to see your live HBAR and uINR from the
            mirror node, and your Udhaar invoice tokens from the bond registry.
          </p>
        </div>

        <div className="flex flex-col items-start gap-2.5 sm:items-end">
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
            <span className="border border-[#C9B98F] bg-[#F1E8D2] px-2.5 py-1 text-[#1B2340]">
              HashPack
            </span>
            <span className="border border-[#C9B98F] bg-[#FBF6EA] px-2.5 py-1">
              Hedera Testnet
            </span>
            {accountId && <StampBadge label="CONNECTED" tone="green" tilt={false} />}
          </div>

          {!PROJECT_ID ? (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <div
                role="status"
                className="border-2 border-[#8A4B08] bg-[#F1E8D2] px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-[#8A4B08]"
              >
                Wallet connect not configured
              </div>
              <p className="m-0 max-w-md text-xs leading-relaxed text-[#5A5E78] sm:text-right">
                {READ_ONLY_NOTE}
              </p>
            </div>
          ) : accountId ? (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadAccountBalances(accountId)}
                  disabled={loadingBalances}
                  className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-[#1B2340] bg-[#F1E8D2] px-3.5 py-2.5 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-[#1B2340] hover:bg-[#E7DAC0] disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingBalances ? "animate-spin" : ""}`} />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  disabled={disconnecting}
                  className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-[#B3261E] bg-[#FBF6EA] px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-[#B3261E] hover:bg-[#B3261E] hover:text-[#FBF6EA] disabled:opacity-50"
                >
                  <Unplug className="h-3.5 w-3.5" />
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
              <p className="m-0 max-w-md text-xs leading-relaxed text-[#5A5E78] sm:text-right">
                {READ_ONLY_NOTE}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => void handleConnectHashPack()}
                  disabled={connectingMode !== null}
                  className="btn inline-flex cursor-pointer items-center gap-2 border-2 border-[#1B2340] bg-[#1B2340] px-5 py-3 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-[#F1E8D2] hover:text-[#F1E8D2] disabled:opacity-50"
                >
                  {connectingMode === "extension" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Connecting HashPack…
                    </>
                  ) : (
                    <>
                      <Wallet className="h-4 w-4" />
                      Connect HashPack
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConnectModal()}
                  disabled={connectingMode !== null}
                  className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-[#1B2340] bg-[#F1E8D2] px-4 py-3 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-[#1B2340] hover:bg-[#E7DAC0] disabled:opacity-50"
                >
                  {connectingMode === "modal" ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Opening modal…
                    </>
                  ) : (
                    "Pair via QR / Modal"
                  )}
                </button>
              </div>
              <p className="m-0 max-w-md text-xs leading-relaxed text-[#5A5E78] sm:text-right">
                {READ_ONLY_NOTE}
              </p>
            </div>
          )}
        </div>
      </div>

      {walletErr && (
        <div className="mt-5">
          <ErrorNote message={walletErr.message} />
        </div>
      )}

      {accountId && (
        <div className="mt-6 border-t-2 border-dashed border-[#C9B98F] pt-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/* Connected Account Card */}
            <div className="border border-[#1B2340] bg-[#F1E8D2] p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#5A5E78]">
                  HEDERA ACCOUNT (TESTNET)
                </span>
                <StampBadge label="READ-ONLY" tone="blue" tilt={false} className="px-1.5 py-0 text-[10px]" />
              </div>
              <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
                <a
                  href={hashscanAccountUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xl font-semibold text-[#1B2340] underline decoration-[#B3261E] decoration-2 underline-offset-4 hover:text-[#B3261E]"
                >
                  {accountId}
                </a>
                <HashscanLink href={hashscanAccountUrl} label="HashScan" />
              </div>
            </div>

            {/* HBAR Balance Card */}
            <div className="border border-[#1B2340] bg-[#FBF6EA] p-4">
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#5A5E78]">
                HBAR BALANCE
              </span>
              <div className="mt-2 font-mono text-xl font-semibold text-[#1B2340]">
                {loadingBalances && !balances ? (
                  <span className="text-sm text-[#5A5E78]">Reading mirror node…</span>
                ) : (
                  <>
                    {(balances?.hbar ?? 0).toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 4,
                    })}{" "}
                    <span className="text-xs font-normal text-[#5A5E78]">HBAR</span>
                  </>
                )}
              </div>
            </div>

            {/* uINR Balance Card */}
            <div className="border border-[#1B2340] bg-[#FBF6EA] p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#5A5E78]">
                  uINR BALANCE (RUPEES)
                </span>
                {balances?.uinrTokenId && (
                  <span className="font-mono text-[11px] text-[#5A5E78]">
                    {balances.uinrTokenId}
                  </span>
                )}
              </div>
              <div className="mt-2 font-mono text-xl font-semibold text-[#1B2340]">
                {loadingBalances && !balances ? (
                  <span className="text-sm text-[#5A5E78]">Reading mirror node…</span>
                ) : (
                  <>
                    {inrPrice(balances?.uinr ?? 0)}{" "}
                    <span className="text-xs font-normal text-[#5A5E78]">uINR</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Udhaar Bond Units */}
          <div className="mt-4 border border-[#1B2340] bg-[#F1E8D2] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E]">
                UDHAAR BOND UNITS HELD
              </span>
              <span className="font-mono text-xs font-semibold text-[#1B2340]">
                {loadingBalances && !balances
                  ? "Checking bond tokens…"
                  : `${balances?.totalBondUnits ?? 0} ${
                      (balances?.totalBondUnits ?? 0) === 1 ? "unit" : "units"
                    }`}
              </span>
            </div>

            {balances && balances.bonds.length > 0 ? (
              <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {balances.bonds.map((b) => (
                  <div
                    key={b.tokenId}
                    className="flex flex-wrap items-center justify-between gap-3 border border-[#C9B98F] bg-[#FBF6EA] px-3.5 py-2.5"
                  >
                    <div>
                      <div className="font-mono text-xs font-semibold text-[#1B2340]">
                        {b.symbol ?? `UDHR-${b.invoiceId}`} · Invoice #{b.invoiceId}
                      </div>
                      <div className="text-xs text-[#5A5E78]">
                        {b.buyerName} · Token {b.tokenId}
                      </div>
                    </div>
                    <div className="text-right font-mono">
                      <div className="text-sm font-semibold text-[#2F6B4F]">
                        {b.units} {b.units === 1 ? "unit" : "units"}
                      </div>
                      <div className="text-[11px] text-[#5A5E78]">
                        {inr(b.units * b.unitFaceValue)} face
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              !loadingBalances && (
                <p className="m-0 mt-2 font-mono text-xs text-[#5A5E78]">
                  0 Udhaar bond units held on this account.
                </p>
              )
            )}
          </div>
        </div>
      )}
    </section>
  );
}

