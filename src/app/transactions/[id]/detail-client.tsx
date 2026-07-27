"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TransactionDetail, EditRow, ReceiptRow } from "@/lib/transactions";

type Opt = { id: string; name: string };

const money = (v: string | number | null) =>
  Number(v ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</label>
      {children}
    </div>
  );
}

/** Read-only provenance row. */
function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between gap-4 border-b border-gray-100 py-1.5 text-sm last:border-0">
      <span className="text-gray-500">{label}</span>
      <span className="text-right font-mono text-xs text-gray-800 break-all">{value}</span>
    </div>
  );
}

const input = "rounded border border-gray-300 px-2.5 py-1.5 text-sm";

export function TransactionDetailClient({
  txn, edits, receipts, merged, accounts, categories, stores,
}: {
  txn: TransactionDetail;
  edits: EditRow[];
  receipts: ReceiptRow[];
  merged: Record<string, string>[];
  accounts: Opt[];
  categories: Opt[];
  stores: Opt[];
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    txn_date: txn.txn_date,
    amount: txn.amount,
    raw_description: txn.raw_description,
    canonical_store_id: txn.canonical_store_id ?? "",
    category_id: txn.category_id ?? "",
    account_id: txn.account_id,
    status: txn.status,
    notes: txn.notes ?? "",
    purchased_by: txn.purchased_by ?? "",
    excluded_from_totals: txn.excluded_from_totals,
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  const [candidates, setCandidates] = useState<Record<string, string>[] | null>(null);

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true); setMsg(null);
    const res = await fetch(`/api/transactions/${txn.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setMsg(json.error ?? "save failed"); return; }
    setMsg(json.changed.length ? `Saved: ${json.changed.join(", ")}` : "No changes");
    router.refresh();
  }

  async function openMerge() {
    setShowMerge(true);
    setCandidates(null);
    const res = await fetch(`/api/transactions/${txn.id}/merge`);
    const json = await res.json();
    setCandidates(json.candidates ?? []);
  }

  async function doMerge(mergeId: string) {
    const res = await fetch(`/api/transactions/${txn.id}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mergeId, reason: "manual merge from detail page" }),
    });
    const json = await res.json();
    if (!res.ok) { setMsg(json.error ?? "merge failed"); return; }
    setShowMerge(false);
    setMsg(`Merged. ${json.adopted.length ? `Adopted: ${json.adopted.join(", ")}` : "Nothing adopted."}`);
    router.refresh();
  }

  async function undoMerge(mergeRecordId: string) {
    const res = await fetch(`/api/transactions/${txn.id}/merge`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mergeRecordId }),
    });
    if (res.ok) { setMsg("Merge undone"); router.refresh(); }
  }

  const edited = (field: string) => edits.some((e) => e.field === field);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-blue-700 hover:underline">← Ledger</Link>
          <h1 className="mt-2 font-mono text-2xl font-semibold">{txn.display_id}</h1>
          <p className="text-sm text-gray-500">
            {txn.store_name ?? txn.normalized_merchant} · {money(txn.amount)} · {txn.txn_date}
          </p>
        </div>
        <button onClick={openMerge} className="rounded border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">
          Merge duplicate…
        </button>
      </div>

      {txn.merged_into_id && (
        <p className="mb-6 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          This transaction was merged into{" "}
          <Link href={`/transactions/${txn.merged_into_display_id}`} className="font-mono underline">
            {txn.merged_into_display_id}
          </Link>{" "}
          and no longer appears in the ledger.
        </p>
      )}
      {msg && <p className="mb-6 rounded border bg-gray-50 p-3 text-sm">{msg}</p>}

      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        {/* ── DATA: editable ───────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Transaction data
          </h2>
          <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
            <Field label={`Date${edited("txn_date") ? " (edited)" : ""}`}>
              <input type="date" className={input} value={form.txn_date}
                onChange={(e) => set("txn_date", e.target.value)} />
            </Field>
            <Field label={`Amount${edited("amount") ? " (edited)" : ""}`}>
              <input type="number" step="0.01" className={input} value={form.amount}
                onChange={(e) => set("amount", e.target.value)} />
              <span className="text-xs text-gray-400">negative = money out</span>
            </Field>
            <Field label="Store">
              <select className={input} value={form.canonical_store_id}
                onChange={(e) => set("canonical_store_id", e.target.value)}>
                <option value="">— none —</option>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select className={input} value={form.category_id}
                onChange={(e) => set("category_id", e.target.value)}>
                <option value="">— uncategorized —</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Account">
              <select className={input} value={form.account_id}
                onChange={(e) => set("account_id", e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className={input} value={form.status} onChange={(e) => set("status", e.target.value)}>
                {["posted", "pending", "scheduled"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Description">
              <input className={input} value={form.raw_description}
                onChange={(e) => set("raw_description", e.target.value)} />
            </Field>
            <Field label="Purchased by">
              <input className={input} value={form.purchased_by}
                onChange={(e) => set("purchased_by", e.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes">
                <textarea className={input} rows={2} value={form.notes}
                  onChange={(e) => set("notes", e.target.value)} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={form.excluded_from_totals}
                onChange={(e) => set("excluded_from_totals", e.target.checked)} />
              Exclude from totals (transfers, internal moves)
            </label>
          </div>
          <button onClick={save} disabled={saving}
            className="mt-4 rounded bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? "Saving…" : "Save changes"}
          </button>
        </section>

        {/* ── METADATA: immutable ──────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Metadata
          </h2>
          <div className="rounded-lg border bg-gray-50 p-4">
            <Meta label="Transaction ID" value={txn.display_id} />
            <Meta label="Internal id" value={txn.id} />
            <Meta label="Source" value={txn.source} />
            <Meta label="Imported from" value={txn.import_filename} />
            <Meta label="Adapter" value={txn.import_adapter} />
            <Meta label="Imported at" value={txn.imported_at?.slice(0, 19)} />
            <Meta label="Created" value={txn.created_at.slice(0, 19)} />
            <Meta label="Updated" value={txn.updated_at.slice(0, 19)} />
            <Meta label="External ref" value={txn.external_ref} />
            {/* The as-imported snapshot. Frozen: the dedup fingerprint is computed from
                these, which is what makes the fields on the left safe to edit. */}
            <Meta label="Imported date" value={txn.imported_txn_date} />
            <Meta label="Imported amount" value={txn.imported_amount ? money(txn.imported_amount) : null} />
            <Meta label="Imported description" value={txn.imported_description} />
            <Meta label="Bank category" value={txn.bank_category} />
            <Meta label="Sheet category" value={txn.source_category} />
            <Meta label="Type" value={txn.txn_type} />
            <Meta label="Occurrence" value={String(txn.occurrence_n)} />
            <Meta label="Normalized merchant" value={txn.normalized_merchant} />
            <Meta label="Category source" value={txn.category_source} />
            <Meta label="Fingerprint" value={txn.fingerprint.slice(0, 16) + "…"} />
          </div>

          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Receipts
          </h2>
          {receipts.length === 0 ? (
            <p className="rounded border border-dashed p-4 text-sm text-gray-500">
              No receipt attached.
            </p>
          ) : (
            <div className="space-y-3">
              {receipts.map((r) => (
                <div key={r.id} className="rounded-lg border p-3 text-sm">
                  <div className="mb-1 font-medium">{r.kind === "photo" ? "Photo" : "Email"}</div>
                  {r.kind === "photo" && r.blob_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.blob_url} alt="receipt" className="max-h-64 rounded border" />
                  )}
                  {r.kind === "email" && (
                    <div className="text-xs text-gray-600">
                      <div>from {r.email_from}</div>
                      <div>to {r.email_to}</div>
                      <div>{r.email_subject}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {merged.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Merged into this transaction
          </h2>
          <div className="space-y-2">
            {merged.map((m) => (
              <div key={m.merge_id} className="flex items-center justify-between rounded border p-3 text-sm">
                <span>
                  <Link href={`/transactions/${m.display_id}`} className="font-mono text-blue-700 hover:underline">
                    {m.display_id}
                  </Link>
                  {" · "}{m.txn_date} · {money(m.amount)} · <span className="text-gray-500">{m.source}</span>
                </span>
                <button onClick={() => undoMerge(m.merge_id)}
                  className="rounded border px-3 py-1 text-xs hover:bg-gray-50">Undo</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {edits.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Edit history
          </h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr><th className="p-2.5">When</th><th className="p-2.5">Field</th>
                  <th className="p-2.5">From</th><th className="p-2.5">To</th></tr>
              </thead>
              <tbody>
                {edits.map((e, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-2.5 text-gray-500">{e.edited_at.slice(0, 19)}</td>
                    <td className="p-2.5 font-mono text-xs">{e.field}</td>
                    <td className="p-2.5 text-gray-500">{e.old_value ?? "—"}</td>
                    <td className="p-2.5">{e.new_value ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showMerge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowMerge(false)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-auto rounded-lg bg-white p-6"
            onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">Merge a duplicate into {txn.display_id}</h3>
            <p className="mt-1 mb-4 text-sm text-gray-500">
              Same account, same amount, within 7 days. The one you pick keeps its ID and
              provenance but leaves the ledger — merges can be undone.
            </p>
            {candidates === null ? (
              <p className="text-sm text-gray-500">Searching…</p>
            ) : candidates.length === 0 ? (
              <p className="rounded border border-dashed p-6 text-sm text-gray-500">
                No likely duplicates found.
              </p>
            ) : (
              <div className="space-y-2">
                {candidates.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-4 rounded border p-3 text-sm">
                    <div>
                      <span className="font-mono text-xs text-gray-500">{c.display_id}</span>
                      <div>{c.store_name ?? c.raw_description}</div>
                      <div className="text-xs text-gray-500">
                        {c.txn_date} · {money(c.amount)} · {c.source} · {c.account_name}
                        {Number(c.day_gap) > 0 && ` · ${c.day_gap}d apart`}
                      </div>
                    </div>
                    <button onClick={() => doMerge(c.id)}
                      className="shrink-0 rounded bg-black px-3 py-1.5 text-xs font-medium text-white">
                      Merge in
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
