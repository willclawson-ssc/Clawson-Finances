/**
 * Does pending → posted reconciliation actually work?
 *
 * Uses the REAL pending rows sitting in the ledger (three USAA authorizations from
 * 2026-07-23/24) and synthesizes the next statement the way the bank will actually send
 * it: the same charges, Posted, with the restaurant tips settled. That is the scenario
 * that silently duplicates spending today, so it is the one worth asserting on.
 *
 * Read-only against the database.
 *
 * Run: npx tsx scripts/test-reconcile.mts
 */
import { neon } from "@neondatabase/serverless";
import { matchSettlements, type ExistingPending } from "../src/lib/reconcile";
import type { ParsedRow } from "../src/lib/adapters";

const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);

const pending = (await sql`
  SELECT id, txn_date::text AS txn_date, raw_description, normalized_merchant,
         amount::text AS amount, status::text AS status
  FROM transactions WHERE status <> 'posted' ORDER BY txn_date
`) as ExistingPending[];

console.log(`live pending/scheduled rows: ${pending.length}`);
for (const p of pending) console.log(`   ${p.txn_date}  ${p.status.padEnd(9)} ${p.amount.toString().padStart(9)}  ${p.normalized_merchant}`);

const posted = (over: ExistingPending, amount: number, dayLag: number, desc?: string): ParsedRow => ({
  txnDate: new Date(Date.parse(over.txn_date + "T00:00:00Z") + dayLag * 86_400_000)
    .toISOString().slice(0, 10),
  postDate: null,
  rawDescription: desc ?? over.raw_description,
  normalizedMerchant: over.normalized_merchant,
  amount,
  status: "posted",
  bankCategory: null,
  purchasedBy: null,
  txnType: null,
  occurrenceN: 1,
});

const olive = pending.find((p) => p.normalized_merchant.startsWith("OLIVE"))!;
const mcd = pending.find((p) => p.normalized_merchant.startsWith("MCDONALDS"))!;
const paypal = pending.find((p) => p.normalized_merchant.startsWith("PAYPAL"))!;

const cases: { name: string; incoming: ParsedRow[]; expectSettled: number }[] = [
  {
    // The real one: $34.00 authorization settles at $40.80 once a 20% tip lands, 2 days later.
    name: "restaurant tip raises the amount",
    incoming: [posted(olive, -40.8, 2)],
    expectSettled: 1,
  },
  {
    name: "exact same amount, settles next day",
    incoming: [posted(mcd, -1.85, 1)],
    expectSettled: 1,
  },
  {
    // Guard against over-matching: a genuinely different charge at the same merchant
    // must NOT absorb the pending row.
    name: "unrelated charge at same merchant is left alone",
    incoming: [posted(paypal, -240.0, 1)],
    expectSettled: 0,
  },
  {
    name: "settles too late (9 days) — not a settlement",
    incoming: [posted(olive, -34.0, 9)],
    expectSettled: 0,
  },
  {
    // A pending authorization can only settle once, however many similar charges arrive.
    name: "one pending row absorbs at most one posted row",
    incoming: [posted(olive, -34.0, 1), posted(olive, -34.0, 1)],
    expectSettled: 1,
  },
  {
    name: "still-pending re-export is left to fingerprint dedup",
    incoming: [{ ...posted(olive, -34.0, 0), status: "pending" as const }],
    expectSettled: 0,
  },
];

let failures = 0;
for (const c of cases) {
  const { settlements, fresh } = matchSettlements(c.incoming, pending);
  const ok = settlements.length === c.expectSettled &&
    fresh.length === c.incoming.length - c.expectSettled;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}  ` +
    `(settled ${settlements.length}/${c.expectSettled}, insert ${fresh.length})`,
  );
}

// The whole point: without reconciliation these become duplicate spending.
const next = [posted(olive, -40.8, 2), posted(mcd, -1.85, 1), posted(paypal, -52.18, 1)];
const { settlements, fresh } = matchSettlements(next, pending);
console.log(
  `\nnext real USAA import (3 settling charges): ` +
  `${settlements.length} updated in place, ${fresh.length} inserted — ` +
  `${settlements.length} duplicate transactions avoided`,
);
if (settlements.length !== 3) failures++;

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
