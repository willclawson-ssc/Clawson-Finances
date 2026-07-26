"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Account } from "@/lib/db";

interface ImportResult {
  adapter?: string;
  account?: string;
  parsed?: number;
  inserted?: number;
  duplicates?: number;
  unparseable?: number;
  range?: { from: string; to: string };
  error?: string;
}

export function ImportPanel({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [showAdd, setShowAdd] = useState(accounts.length === 0);

  async function onImport(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/import", { method: "POST", body: form });
      setResult(await res.json());
      router.refresh();
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function onAddAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: f.get("name"),
          institution: f.get("institution"),
          type: f.get("type"),
          supportsCsv: f.get("supportsCsv") === "on",
        }),
      });
      const j = await res.json();
      if (j.error) setResult({ error: j.error });
      else {
        setShowAdd(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const csvAccounts = accounts.filter((a) => a.supports_csv);

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Import a statement
        </h2>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="text-sm text-blue-600 hover:underline"
        >
          {showAdd ? "Cancel" : "+ Add account"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={onAddAccount} className="mb-5 grid gap-3 rounded border bg-gray-50 p-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">Account name</span>
            <input name="name" required placeholder="USAA Checking" className="w-full rounded border p-2" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">Institution</span>
            <input name="institution" required placeholder="USAA" className="w-full rounded border p-2" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">Type</span>
            <select name="type" required className="w-full rounded border p-2" defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              <option value="asset">Asset (checking / savings)</option>
              <option value="liability">Liability (credit card)</option>
            </select>
            {/* This choice, not the file, determines the sign of every imported amount. */}
            <span className="mt-1 block text-xs text-gray-500">
              Determines how amounts are signed. Getting it wrong inverts the account.
            </span>
          </label>
          <label className="flex items-end gap-2 text-sm">
            <input type="checkbox" name="supportsCsv" defaultChecked className="mb-2.5" />
            <span className="mb-2 text-gray-600">Bank offers CSV export</span>
          </label>
          <div>
            <button
              disabled={busy}
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Add account
            </button>
          </div>
        </form>
      )}

      {csvAccounts.length === 0 ? (
        <p className="text-sm text-gray-500">
          Add an account that supports CSV export to import statements.
        </p>
      ) : (
        <form onSubmit={onImport} className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">Account</span>
            {/* Explicit pick, never auto-detected: both USAA exports are named
                bk_download.csv with identical headers and nothing identifying the account. */}
            <select name="accountId" required className="rounded border p-2" defaultValue="">
              <option value="" disabled>
                Choose the account this file belongs to…
              </option>
              {csvAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.type})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">CSV file</span>
            <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
          </label>
          <button
            disabled={busy}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </form>
      )}

      {result && (
        <div
          className={`mt-4 rounded border p-3 text-sm ${
            result.error ? "border-red-300 bg-red-50 text-red-800" : "border-green-300 bg-green-50"
          }`}
        >
          {result.error ? (
            result.error
          ) : (
            <>
              <strong>{result.adapter?.toUpperCase()}</strong> · {result.account} ·{" "}
              {result.range?.from} → {result.range?.to}
              <br />
              parsed {result.parsed} · <strong>inserted {result.inserted}</strong> ·{" "}
              {/* Duplicates are expected and good: it means re-import is idempotent. */}
              {result.duplicates} already present
              {result.unparseable ? ` · ${result.unparseable} unparseable` : ""}
            </>
          )}
        </div>
      )}
    </section>
  );
}
