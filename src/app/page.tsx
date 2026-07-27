import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { accountSummaries, recentTransactions, listAccounts } from "@/lib/db";
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

  const [summaries, txns, accounts] = await Promise.all([
    accountSummaries(),
    recentTransactions(100),
    listAccounts(),
  ]);

  const net = summaries.reduce((a, s) => a + Number(s.balance ?? 0), 0);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Clawson Finances</h1>
          <p className="text-sm text-gray-500">
            {summaries.reduce((a, s) => a + s.txn_count, 0).toLocaleString()} transactions
            {" · net change "}
            {money(net)}
          </p>
          {/*
            Deliberately "net change", never "spent". On a liability account this sum is
            the balance change: card payments come in as inflows and largely cancel the
            purchases (the real USAA card export nets +$1,598 over 18 months). A true
            spend figure requires transfer detection, which isn't built yet — so labelling
            this "spent" would be actively wrong.
          */}
          <p className="mt-1 text-xs text-amber-700">
            Transfers between accounts aren&apos;t detected yet, so card payments still count
            here. This is not a spending total.
          </p>
        </div>
        <UserButton />
      </header>

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
                <div className="mt-1 text-xl tabular-nums">{money(s.balance)}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {s.txn_count.toLocaleString()} txns
                  {/* Staleness is stated outright rather than implied. */}
                  {s.reconciled_through
                    ? ` · reconciled through ${s.reconciled_through}`
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
