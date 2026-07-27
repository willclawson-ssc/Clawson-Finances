import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { accountSummaries, recentTransactions, listAccounts, spendReport } from "@/lib/db";
import { ImportPanel } from "./import-panel";

export const dynamic = "force-dynamic";

const money = (v: string | number | null) => {
  const n = Number(v ?? 0);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

export default async function Home() {
  const { userId } = await auth();

  if (!userId) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <h1 className="text-2xl font-semibold">Clawson Finances</h1>
        <p className="text-sm text-gray-500">Sign-in is restricted to invited accounts.</p>
        <SignInButton>
          <button className="rounded bg-black px-5 py-2.5 text-sm font-medium text-white">
            Sign in
          </button>
        </SignInButton>
      </main>
    );
  }

  const [summaries, txns, accounts, report] = await Promise.all([
    accountSummaries(),
    recentTransactions(100),
    listAccounts(),
    spendReport(),
  ]);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Clawson Finances</h1>
          {/*
            The word "spent" is finally allowed here, and transfer detection is what earned
            it: the 768 rows whose vendor is a transfer (card payments, Marcus, Bonvenu,
            Venmo, GuideStone) no longer count, so this is purchases rather than balance
            movement.

            But it is reported PER ERA, not as one figure, because the sheet and CSV
            histories overlap and a combined total would read ~$564k against ~$181k of
            real spending per era. Splitting is what makes each number true; a single
            total with an apology attached would not be.
          */}
          <p className="text-sm text-gray-500">
            {summaries.reduce((a, s) => a + s.txn_count, 0).toLocaleString()} transactions
            {" · "}
            {report.transfer_rows.toLocaleString()} transfers excluded from spending
            {report.unpaired_transfers > 0 &&
              ` (${report.unpaired_transfers.toLocaleString()} to accounts outside this ledger)`}
            {report.reward_rows > 0 && (
              <>
                {" · "}
                {money(report.rewards)} cashback &amp; rewards
                <span className="text-gray-400"> (counted as neither)</span>
              </>
            )}
          </p>
        </div>
        <UserButton />
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Spending
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {report.eras.map((e) => (
            <div key={e.era} className="rounded-lg border p-4">
              <div className="text-xs uppercase tracking-wide text-gray-400">
                {e.era === "sheet" ? "Google Sheet history" : "Bank CSV exports"}
              </div>
              <div className="mt-1 text-xl tabular-nums">{money(e.spent)} spent</div>
              <div className="mt-1 text-sm tabular-nums text-gray-500">
                {money(e.received)} received
              </div>
              <div className="mt-2 text-xs text-gray-500">
                {e.from} → {e.to} · {e.txn_count.toLocaleString()} txns
              </div>
            </div>
          ))}
        </div>
        {/* The backlog is stated as a number, not as a vague caveat. */}
        <p className="mt-2 text-xs text-amber-700">
          Split by era on purpose: {report.superseded_sheet_rows.toLocaleString()} sheet rows
          inside the CSV period describe purchases the CSVs already cover, so counting both
          would double them. They are excluded here until reconciliation merges them.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Accounts
        </h2>
        {summaries.length === 0 ? (
          <p className="rounded border border-dashed p-6 text-sm text-gray-500">
            No accounts yet. Add one below before importing a statement.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {summaries.map((s) => (
              <div key={s.id} className="rounded-lg border p-4">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs uppercase text-gray-400">{s.type}</span>
                </div>
                {/* "Net change", not "balance" — there is no opening balance to add it to.
                    It counts transfers, because paying the card really does move money;
                    the in/out line below deliberately does not. */}
                <div className="mt-1 text-xl tabular-nums">{money(s.net_change)}</div>
                <div className="text-xs text-gray-400">
                  net change{s.covered_from && ` since ${s.covered_from}`}
                </div>
                <div className="mt-2 text-xs tabular-nums text-gray-500">
                  {money(s.money_out)} out · {money(s.money_in)} in
                  <span className="text-gray-400"> (excl. transfers)</span>
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {s.txn_count.toLocaleString()} txns
                  {/* Staleness is stated outright rather than implied. */}
                  {s.reconciled_through
                    ? ` · through ${s.reconciled_through}`
                    : " · nothing imported yet"}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <ImportPanel accounts={accounts} />

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Recent transactions
        </h2>
        {txns.length === 0 ? (
          <p className="rounded border border-dashed p-6 text-sm text-gray-500">
            Nothing imported yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="p-2.5">ID</th>
                  <th className="p-2.5">Date</th>
                  <th className="p-2.5">Merchant</th>
                  <th className="p-2.5">Account</th>
                  <th className="p-2.5">Category</th>
                  <th className="p-2.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} className="border-t hover:bg-gray-50">
                    <td className="whitespace-nowrap p-2.5">
                      <Link href={`/transactions/${t.display_id}`}
                        className="font-mono text-xs text-blue-700 hover:underline">
                        {t.display_id}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap p-2.5 tabular-nums text-gray-600">
                      {t.txn_date}
                    </td>
                    <td className="p-2.5">
                      {/* Canonical vendor name, falling back to the normalized string.
                          Hover reveals the raw descriptor it was resolved from. */}
                      <span title={t.raw_description}>{t.store_name ?? t.normalized_merchant}</span>
                      {t.status !== "posted" && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          {t.status}
                        </span>
                      )}
                    </td>
                    <td className="p-2.5 text-gray-600">{t.account_name}</td>
                    <td className="p-2.5 text-gray-500">
                      {t.category_name ?? <span className="text-gray-300">uncategorized</span>}
                    </td>
                    <td
                      className={`p-2.5 text-right tabular-nums ${
                        Number(t.amount) < 0 ? "" : "text-green-700"
                      }`}
                    >
                      {money(t.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
