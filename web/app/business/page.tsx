"use client";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Async, AsyncButton, Empty, ErrorNote, Field, GradeBadge, HashscanLink, PageHeader, StatCard, StatusTracker, SuccessNote } from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import {
  DuplicateInvoiceError, getBusinessInvoices, getBusinessSummary, getCompanies, getSuppliers,
  getTransferableInvoices, paySupplierWithUnits, uploadInvoice,
} from "@/lib/api";
import { errMsg, fmtDate, inr } from "@/lib/utils";
import type { Invoice } from "@/lib/types";

export default function BusinessPage() {
  const summary = useAsync(getBusinessSummary);
  const invoices = useAsync(getBusinessInvoices);
  const refresh = () => { summary.reload(); invoices.reload(); };

  return (
    <div className="space-y-10">
      <PageHeader title="Business dashboard" subtitle="Ramesh Cement Traders · get cash today against unpaid invoices" />

      <Async state={summary}>
        {(s) => (
          <div className="grid gap-6 sm:grid-cols-3">
            <StatCard label="Received" value={inr(s.received)} hint="Funding paid out to you" />
            <StatCard label="Pending" value={inr(s.pending)} hint="Invoices not yet funded" />
            <StatCard label="Invoices" value={String(s.invoiceCount)} />
          </div>
        )}
      </Async>

      <div className="grid gap-8 lg:grid-cols-2">
        <UploadForm onDone={refresh} invoices={invoices.data ?? []} />
        <PaySupplierForm onDone={refresh} />
      </div>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-slate-900">Your invoices</h2>
        <Async state={invoices}>
          {(list) =>
            list.length === 0 ? <Empty>No invoices yet.</Empty> : (
              <div className="space-y-5">
                {list.map((inv) => <InvoiceRow key={inv.id} inv={inv} />)}
              </div>
            )
          }
        </Async>
      </section>
    </div>
  );
}

function InvoiceRow({ inv }: { inv: Invoice }) {
  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-slate-900">{inv.id} · {inv.buyerName}</p>
            <p className="text-sm text-slate-500">{inr(inv.amount)} · due {fmtDate(inv.dueDate)}</p>
          </div>
          <div className="flex items-center gap-3">
            {inv.grade && <GradeBadge grade={inv.grade} />}
            {inv.tokenId && <Badge variant="indigo">Token {inv.tokenId}</Badge>}
            <HashscanLink href={inv.hashscanUrl} />
          </div>
        </div>
        <StatusTracker status={inv.status} />
      </CardContent>
    </Card>
  );
}

function UploadForm({ onDone, invoices }: { onDone: () => void; invoices: Invoice[] }) {
  const buyers = useAsync(getCompanies);
  const [buyerId, setBuyerId] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [pdf, setPdf] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dupUrl, setDupUrl] = useState<string | undefined>();
  const [ok, setOk] = useState<{ id: string; url: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null); setDupUrl(undefined); setOk(null);
    try {
      const { invoice, tx } = await uploadInvoice({ buyerId, amount: Number(amount), dueDate, pdfName: pdf || "invoice.pdf" });
      setOk({ id: invoice.id, url: tx.hashscanUrl });
      onDone();
    } catch (err) {
      setError(errMsg(err));
      if (err instanceof DuplicateInvoiceError) setDupUrl(err.hashscanUrl);
    } finally {
      setLoading(false);
    }
  }

  function fillDuplicate() {
    const src = invoices.find((i) => i.id === "INV-0042");
    if (!src) return;
    setBuyerId(src.buyerId); setAmount(String(src.amount)); setDueDate(src.dueDate.slice(0, 10)); setPdf("INV-0042.pdf");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload invoice</CardTitle>
        <CardDescription>Its fingerprint is written to a public registry to stop double financing.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <Field label="Buyer">
            <Select required value={buyerId} onChange={(e) => setBuyerId(e.target.value)}>
              <option value="">Select buyer…</option>
              {(buyers.data ?? []).filter((c) => c.type !== "supplier").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Amount (₹)"><Input required type="number" min={1000} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500000" /></Field>
            <Field label="Due date"><Input required type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          </div>
          <Field label="Invoice PDF">
            <Input type="file" accept="application/pdf" onChange={(e) => setPdf(e.target.files?.[0]?.name ?? "")} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={loading}>Upload invoice</Button>
            <Button type="button" variant="ghost" size="sm" onClick={fillDuplicate}>Fill duplicate example</Button>
          </div>
          {error && (
            <div className="space-y-1">
              <ErrorNote message={error} />
              {dupUrl && <p className="text-xs text-slate-500">First upload&apos;s registry record: <HashscanLink href={dupUrl} /></p>}
            </div>
          )}
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
        <CardDescription>Send part of your invoice token. They are repaid by the buyer at maturity.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => e.preventDefault()} className="space-y-5">
          <Field label="Invoice token" hint={selected ? `You hold ${selected.retainedUnits} units of ${inr(face)}` : undefined}>
            <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">Select invoice…</option>
              {(tokens.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.id} · {i.buyerName}</option>)}
            </Select>
          </Field>
          <Field label="Supplier">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select supplier…</option>
              {(suppliers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.kycVerified ? "" : " (not verified)"}</option>)}
            </Select>
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Amount (₹)">
              <Input type="number" min={0} value={amount} onChange={(e) => { setAmount(e.target.value); setUnits(e.target.value ? String(Math.ceil(Number(e.target.value) / face)) : ""); }} placeholder="100000" />
            </Field>
            <Field label="Units">
              <Input type="number" min={1} value={units} onChange={(e) => { setUnits(e.target.value); setAmount(e.target.value ? String(Number(e.target.value) * face) : ""); }} placeholder="100" />
            </Field>
          </div>
          <AsyncButton
            action={() => paySupplierWithUnits({ invoiceId, supplierId, amount: Number(amount), units: Number(units) })}
            onDone={() => { tokens.reload(); onDone(); }}
            disabled={!invoiceId || !supplierId || !units}
          >
            Pay with units
          </AsyncButton>
        </form>
      </CardContent>
    </Card>
  );
}

