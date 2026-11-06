"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import {
  Async,
  AsyncButton,
  Empty,
  ErrorNote,
  Field,
  GradeBadge,
  HashscanLink,
  InvoiceStamp,
  PageHeader,
  Pending,
  PortalGuard,
  StampBadge,
  StatCard,
  StatusTracker,
  SuccessNote,
} from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import {
  getBusinessInvoices,
  getBusinessSummary,
  getCompanies,
  getMockEInvoice,
  getSuppliers,
  getTransferableInvoices,
  paySupplierWithUnits,
  uploadInvoice,
} from "@/lib/api";
import { RATE_BY_GRADE, errLink, errMsg, fmtDate, inr, pct, termText } from "@/lib/utils";
import type { Invoice } from "@/lib/types";

export default function BusinessPage() {
  const summary = useAsync(getBusinessSummary);
  const invoices = useAsync(getBusinessInvoices);
  const refresh = () => {
    summary.reload();
    invoices.reload();
  };

  return (
    <PortalGuard>
      <div className="space-y-10">
        <PageHeader
          folio="Folio · Business (Ramesh · 0.0.11310318)"
          title="Business khata"
          subtitle="Ramesh Cement Traders · get cash today against unpaid invoices"
        />

        <Async state={summary}>
          {(s) => (
            <div className="grid gap-6 sm:grid-cols-3">
              <StatCard
                label="Received"
                value={inr(s.received)}
                hint="Credited on sold units, incl. units sent to suppliers"
              />
              <StatCard
                label="Pending"
                value={inr(s.pending)}
                hint="Invoices not yet funded"
              />
              <StatCard label="Invoices" value={String(s.invoiceCount)} />
            </div>
          )}
        </Async>

        <div className="grid gap-8 lg:grid-cols-2">
          <UploadForm onDone={refresh} invoices={invoices.data ?? []} />
          <PaySupplierForm onDone={refresh} />
        </div>

        <section>
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-serif text-3xl font-normal text-[#1B2340]">Your invoices</h2>
            <span className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
              Bahi-khata ledger entries
            </span>
          </div>
          <Async state={invoices}>
            {(list) =>
              list.length === 0 ? (
                <Empty>No invoices yet.</Empty>
              ) : (
                <div className="space-y-6">
                  {list.map((inv) => (
                    <InvoiceRow key={inv.id} inv={inv} />
                  ))}
                </div>
              )
            }
          </Async>
        </section>
      </div>
    </PortalGuard>
  );
}

function InvoiceRow({ inv }: { inv: Invoice }) {
  return (
    <Card className="khata-ruled relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5"
      />
      <CardContent className="space-y-5 py-6 pr-6 pl-7 sm:pl-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-serif text-2xl text-[#1B2340]">
              <span className="font-mono text-lg font-semibold">{inv.id}</span> · {inv.buyerName}
            </p>
            <p className="font-mono text-sm text-[#5A5E78]">
              <strong className="font-semibold text-[#1B2340]">{inr(inv.amount)}</strong> · due{" "}
              {fmtDate(inv.dueDate)}
              {inv.invoiceNumber ? ` · #${inv.invoiceNumber}` : ""}
              {inv.fingerprint ? ` · ${inv.fingerprint.slice(0, 18)}…` : ""}
            </p>
            {inv.grade && (
              <p className="font-mono text-xs font-semibold text-[#1B2340]">
                {termText(RATE_BY_GRADE[inv.grade], inv.dueDate, inv.grade)}
                {inv.discountPct != null && (
                  <span className="font-normal text-[#5A5E78]"> · {pct(inv.discountPct)} discount</span>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <InvoiceStamp status={inv.status} />
            {inv.grade && <GradeBadge grade={inv.grade} />}
            {inv.tokenId && <StampBadge label={`Bond ${inv.tokenId}`} tone="navy" tilt={false} />}
            <HashscanLink href={inv.hashscanUrl} />
          </div>
        </div>
        <StatusTracker status={inv.status} />
        {inv.links && inv.links.some((l) => Boolean(l.url)) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[#C9B98F] pt-3">
            {inv.links
              .filter((l) => Boolean(l.url))
              .map((l) => (
                <HashscanLink
                  key={`${l.label}-${l.url}`}
                  href={l.url}
                  label={`HashScan: ${l.label}`}
                />
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UploadForm({ onDone, invoices }: { onDone: () => void; invoices: Invoice[] }) {
  const buyers = useAsync(getCompanies);
  const [buyerId, setBuyerId] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [pdf, setPdf] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errUrl, setErrUrl] = useState<string | undefined>();
  const [ok, setOk] = useState<{ id: string; url: string } | null>(null);
  // The signed QR from the mock IRP, with the fields it was signed for.
  const [einv, setEinv] = useState<{ signedQr: string; buyerId: string; amount: number; invoiceNumber: string } | null>(null);
  const [einvLoading, setEinvLoading] = useState(false);
  const [einvError, setEinvError] = useState<string | null>(null);
  const einvStale =
    einv !== null &&
    (einv.buyerId !== buyerId || einv.amount !== Number(amount) || einv.invoiceNumber !== invoiceNumber);
  const einvReady = Boolean(buyerId) && Number(amount) > 0 && invoiceNumber.trim().length > 0;

  async function getEinvoice() {
    setEinvLoading(true);
    setEinvError(null);
    try {
      const r = await getMockEInvoice({ buyerId, invoiceNumber, amount: Number(amount) });
      setEinv({ signedQr: r.signedQr, buyerId, amount: Number(amount), invoiceNumber });
    } catch (err) {
      setEinv(null);
      setEinvError(errMsg(err));
    } finally {
      setEinvLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setErrUrl(undefined);
    setOk(null);
    try {
      const { invoice, tx } = await uploadInvoice({
        buyerId,
        amount: Number(amount),
        dueDate,
        pdfName: pdf || "invoice.pdf",
        invoiceNumber,
        signedQr: einv?.signedQr,
      });
      setOk({ id: invoice.id, url: tx.hashscanUrl });
      setEinv(null);
      onDone();
    } catch (err) {
      setError(errMsg(err));
      setErrUrl(errLink(err));
    } finally {
      setLoading(false);
    }
  }

  function fillDuplicate() {
    const src = invoices.find((i) => i.status !== "buyer_rejected");
    if (!src) return;
    setBuyerId(src.buyerId);
    setAmount(String(src.amount));
    setDueDate(src.dueDate.slice(0, 10));
    setInvoiceNumber(src.invoiceNumber ?? "");
    setPdf(src.pdfName ?? "");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload invoice</CardTitle>
        <CardDescription>
          Its fingerprint is written to a public registry to stop double financing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <Field label="Buyer">
            <Select required value={buyerId} onChange={(e) => setBuyerId(e.target.value)}>
              <option value="">Select buyer…</option>
              {(buyers.data ?? [])
                .filter((c) => c.type !== "supplier")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.hederaAccount})
                  </option>
                ))}
            </Select>
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Amount (₹)">
              <Input
                required
                type="number"
                min={1000}
                step={1000}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="500000"
              />
            </Field>
            <Field label="Due date">
              <Input
                required
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Invoice number"
            hint="Identifies this invoice, so two real invoices with the same details are not mistaken for duplicates."
          >
            <Input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="BB-2026-0042"
            />
          </Field>
          <div className="space-y-2 border border-dashed border-[#C9B98F] bg-[#F1E8D2]/40 p-4">
            <p className="font-mono text-xs uppercase tracking-[0.06em] text-[#1B2340]">
              E-invoice <span className="normal-case text-[#5A5E78]">(optional)</span>
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={einvLoading}
                disabled={!einvReady}
                onClick={getEinvoice}
              >
                {einv ? "Get a new e-invoice from IRP (mock)" : "Get e-invoice from IRP (mock)"}
              </Button>
              {einv && !einvStale && (
                <StampBadge label="Signed by mock IRP ✓" tone="green" tilt={false} />
              )}
            </div>
            {!einvReady && (
              <p className="font-mono text-xs text-[#5A5E78]">
                Fill in the buyer, amount and invoice number first. The e-invoice is signed for those.
              </p>
            )}
            {einvStale && (
              <p role="status" className="font-mono text-xs text-[#8A4B08]">
                The buyer, amount or invoice number changed after signing. Get a new e-invoice, or
                the server will refuse this one.
              </p>
            )}
            <ErrorNote message={einvError} />
          </div>
          <Field label="Invoice PDF">
            <Input
              type="file"
              accept="application/pdf"
              onChange={(e) => setPdf(e.target.files?.[0]?.name ?? "")}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={loading}>
              Upload invoice
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={fillDuplicate}>
              Fill duplicate example
            </Button>
          </div>
          <Pending active={loading} message="Recording the invoice fingerprint on Hedera…" />
          <ErrorNote message={error} href={errUrl} />
          {ok && <SuccessNote href={ok.url}>{ok.id} submitted to your buyer.</SuccessNote>}
        </form>
      </CardContent>
    </Card>
  );
}

function PaySupplierForm({ onDone }: { onDone: () => void }) {
  const suppliers = useAsync(getSuppliers);
  const tokens = useAsync(getTransferableInvoices);
  const [invoiceId, setInvoiceId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [amount, setAmount] = useState("");
  const [units, setUnits] = useState("");

  const selected = (tokens.data ?? []).find((i) => i.id === invoiceId);
  const face = selected?.unitFaceValue ?? 1000;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pay a supplier with invoice units</CardTitle>
        <CardDescription>
          Send part of your invoice token. They are repaid by the buyer at maturity.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => e.preventDefault()} className="space-y-5">
          <Field
            label="Invoice token"
            hint={selected ? `You hold ${selected.retainedUnits} units of ${inr(face)}` : undefined}
          >
            <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">Select invoice…</option>
              {(tokens.data ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.id} · {i.buyerName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Supplier">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select supplier…</option>
              {(suppliers.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.hederaAccount}){c.kycVerified ? "" : " (not verified)"}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Amount (₹)">
              <Input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setUnits(
                    e.target.value ? String(Math.ceil(Number(e.target.value) / face)) : "",
                  );
                }}
                placeholder="100000"
              />
            </Field>
            <Field label="Units">
              <Input
                type="number"
                min={1}
                value={units}
                onChange={(e) => {
                  setUnits(e.target.value);
                  setAmount(e.target.value ? String(Number(e.target.value) * face) : "");
                }}
                placeholder="100"
              />
            </Field>
          </div>
          <AsyncButton
            action={() =>
              paySupplierWithUnits({
                invoiceId,
                supplierId,
                amount: Number(amount),
                units: Number(units),
              })
            }
            pendingMessage="Transferring bond units on Hedera…"
            onDone={() => {
              tokens.reload();
              onDone();
            }}
            disabled={!invoiceId || !supplierId || !units}
          >
            Pay with units
          </AsyncButton>
        </form>
      </CardContent>
    </Card>
  );
}
