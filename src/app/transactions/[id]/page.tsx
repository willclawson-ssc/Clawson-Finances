import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getTransaction, getEditHistory, getReceipts, getMergedInto,
} from "@/lib/transactions";
import { listAccounts, listCategories, listStores } from "@/lib/db";
import { TransactionDetailClient } from "./detail-client";

export const dynamic = "force-dynamic";

/**
 * Transaction detail. Shows EVERYTHING the ledger knows about one transaction, split the
 * way Will asked for it: editable data on one side, immutable provenance on the other.
 *
 * The route accepts the human handle (/transactions/TXN-000123) or the uuid, so an ID
 * read off the screen can be typed straight into the URL bar.
 */
export default async function TransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const { id } = await params;
  const txn = await getTransaction(decodeURIComponent(id));
  if (!txn) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Link href="/" className="text-sm text-blue-700 hover:underline">← Ledger</Link>
        <p className="mt-8 rounded border border-dashed p-6 text-sm text-gray-500">
          No transaction with id <code>{decodeURIComponent(id)}</code>.
        </p>
      </main>
    );
  }

  const [edits, receipts, merged, accounts, categories, stores] = await Promise.all([
    getEditHistory(txn.id),
    getReceipts(txn.id),
    getMergedInto(txn.id),
    listAccounts(),
    listCategories(),
    listStores(),
  ]);

  return (
    <TransactionDetailClient
      txn={txn}
      edits={edits}
      receipts={receipts}
      merged={merged}
      accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
      categories={categories}
      stores={stores}
    />
  );
}
