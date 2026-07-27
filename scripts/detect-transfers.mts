/**
 * Detect transfers, so the app can finally show a spending total instead of "net change".
 *
 * TWO INDEPENDENT PASSES, and the split is the whole design (see db/migrations/0007):
 *
 *   1. EXCLUDE — every row whose canonical vendor is kind='transfer' stops counting as
 *      spending or income. This does NOT require finding the other leg, and that matters
 *      enormously: measured on this ledger, 607 of 763 transfer legs have no counterparty
 *      here at all. Their other side is Marcus, Goldman Sachs, Fidelity, GuideStone,
 *      Venmo or Bonvenu — and Bonvenu has no CSV export, so it can never be imported.
 *      A pairing-only design would leave those still counted.
 *
 *   2. PAIR — where both legs ARE present (156 legs), link them into one transfer_group.
 *      Enrichment, not the mechanism for exclusion.
 *
 * Expected effect on the real ledger, measured before writing anything: USAA Checking goes
 * from -$748.85 "net change" to +$106,039 in / -$75,476 out, and the USAA credit card from
 * a meaningless +$1,598.71 to -$97,573 of actual spending. Those two now roughly balance
 * against each other, which is the sanity check that the exclusions are right.
 *
 * Idempotent: exclusion is a pure function of vendor kind, legs already carrying a group
 * are not re-paired, and review rows are only opened when an identical open one is absent.
 *
 * Run: npx tsx scripts/detect-transfers.mts [--dry-run]
 */
import { neon } from "@neondatabase/serverless";
import { pairTransfers, type TransferLeg } from "../src/lib/transfers";

const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const DRY = process.argv.includes("--dry-run");

interface LegRow {
  id: string;
  account_id: string;
  account_name: string;
  txn_date: string;
  amount: string;
  store_name: string;
  transfer_group_id: string | null;
  excluded_from_totals: boolean;
}

const legRows = (await sql`
  SELECT t.id, t.account_id, a.name AS account_name, t.txn_date::text AS txn_date,
         t.amount::text AS amount, s.name AS store_name,
         t.transfer_group_id, t.excluded_from_totals
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  JOIN canonical_stores s ON s.id = t.canonical_store_id
  WHERE s.kind = 'transfer' AND t.merged_into_id IS NULL
  ORDER BY t.txn_date, t.id
`) as LegRow[];

console.log(`${legRows.length} transfer legs (vendor kind = 'transfer')`);
console.log(`  already excluded: ${legRows.filter((l) => l.excluded_from_totals).length}`);
console.log(`  already grouped:  ${legRows.filter((l) => l.transfer_group_id).length}`);

// ── Pass 2 input: only legs not already paired, so a re-run cannot double-group. ──────
const legs: TransferLeg[] = legRows
  .filter((l) => !l.transfer_group_id)
  .map((l) => ({
    id: l.id,
    accountId: l.account_id,
    txnDate: l.txn_date,
    amount: Number(l.amount),
  }));

const { pairs, ambiguous, unpairedIds } = pairTransfers(legs);
console.log(
  `\npairing: ${pairs.length} pairs · ${ambiguous.length} ambiguous · ` +
    `${unpairedIds.length} with no counterparty in the ledger`,
);

const byId = new Map(legRows.map((l) => [l.id, l]));
for (const p of pairs.slice(0, 5)) {
  const o = byId.get(p.outflowId)!;
  const i = byId.get(p.inflowId)!;
  console.log(
    `  $${p.amount} ${o.account_name} -> ${i.account_name} on ${p.occurredOn} ` +
      `(lag ${p.lagDays}d, ${o.store_name})`,
  );
}
if (pairs.length > 5) console.log(`  ... and ${pairs.length - 5} more`);

for (const a of ambiguous) {
  const l = byId.get(a.legId)!;
  console.log(
    `  AMBIGUOUS ${l.txn_date} ${l.account_name} ${l.amount} ${l.store_name} ` +
      `-> ${a.candidateIds.length} candidates`,
  );
}

// ── Rewards: reported, never auto-classified. ────────────────────────────────────────
// Cashback and statement credits are typed 'income' by the vendor table, which overstates
// earnings — they are neither income nor spending. Whether they become the new
// 'Rewards & Cashback' category or a reduction of the original spend is Will's taxonomy
// call (docs §3, still open), so this script only sizes the problem.
const rewards = (await sql`
  SELECT s.name, COUNT(*)::int AS n, SUM(t.amount)::text AS total
  FROM transactions t
  JOIN canonical_stores s ON s.id = t.canonical_store_id
  WHERE t.merged_into_id IS NULL
    AND s.name IN ('Reward Points Redemption', 'Automatic Statement Credit',
                   'USAA Rewards', 'Cashback Bonus Redemption')
  GROUP BY s.name ORDER BY n DESC
`) as { name: string; n: number; total: string }[];
const rewardTotal = rewards.reduce((a, r) => a + Number(r.total), 0);
console.log(
  `\nrewards still counted as income: ${rewards.reduce((a, r) => a + r.n, 0)} rows, ` +
    `$${rewardTotal.toFixed(2)} — taxonomy decision still open, NOT touched here`,
);

if (DRY) {
  console.log("\n--dry-run: nothing written");
  process.exit(0);
}

// ── Pass 1: exclusion. Set-based and re-runnable; the WHERE clause makes it a no-op on
//    rows already correct, so this does not churn updated_at across the whole ledger. ──
const excluded = (await sql`
  UPDATE transactions t
  SET excluded_from_totals = true, exclusion_reason = 'transfer', updated_at = now()
  FROM canonical_stores s
  WHERE s.id = t.canonical_store_id AND s.kind = 'transfer'
    AND t.merged_into_id IS NULL
    AND (NOT t.excluded_from_totals OR t.exclusion_reason IS DISTINCT FROM 'transfer')
  RETURNING t.id
`) as { id: string }[];
console.log(`\nexcluded ${excluded.length} rows from totals (reason 'transfer')`);

// ── Pass 2: write the groups. Ids are generated here rather than by the database so the
//    group-to-leg mapping never depends on RETURNING order. ─────────────────────────────
if (pairs.length) {
  const groups = pairs.map((p) => ({ ...p, groupId: crypto.randomUUID() }));

  await sql.query(
    `INSERT INTO transfer_groups (id, amount, occurred_on, detected_by, confidence, note)
     SELECT d.id::uuid, d.amount::numeric, d.occurred_on::date, 'pair_match', 1.0, d.note
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
       AS d(id, amount, occurred_on, note)`,
    [
      groups.map((g) => g.groupId),
      groups.map((g) => g.amount.toFixed(2)),
      groups.map((g) => g.occurredOn),
      // Confidence is a flat 1.0: pairTransfers only emits a pair when the match is
      // mutually unique, so there was no competing candidate to be less sure about.
      groups.map((g) => `lag ${g.lagDays}d, mutually unique match`),
    ],
  );

  await sql.query(
    `UPDATE transactions t SET transfer_group_id = d.group_id::uuid, updated_at = now()
     FROM unnest($1::text[], $2::text[]) AS d(txn_id, group_id)
     WHERE t.id = d.txn_id::uuid`,
    [
      groups.flatMap((g) => [g.outflowId, g.inflowId]),
      groups.flatMap((g) => [g.groupId, g.groupId]),
    ],
  );
  console.log(`linked ${groups.length} transfer groups (${groups.length * 2} legs)`);
}

// ── Ambiguous legs go to review rather than being resolved by a coin flip. ────────────
// RETURNING is what makes the count honest: the NOT EXISTS guard means a re-run inserts
// nothing, and reporting ambiguous.length would claim work that did not happen.
let queued = 0;
for (const a of ambiguous) {
  const ins = (await sql`
    INSERT INTO review_queue (transaction_id, reason, suggestion, candidate_txn_id)
    SELECT ${a.legId}::uuid, 'ambiguous_transfer',
           ${JSON.stringify({ candidateIds: a.candidateIds })}::jsonb,
           ${a.candidateIds[0]}::uuid
    WHERE NOT EXISTS (
      SELECT 1 FROM review_queue
      WHERE transaction_id = ${a.legId}::uuid AND reason = 'ambiguous_transfer'
        AND resolved_at IS NULL
    )
    RETURNING id
  `) as { id: string }[];
  queued += ins.length;
}
console.log(
  `queued ${queued} ambiguous legs for review` +
    (queued < ambiguous.length ? ` (${ambiguous.length - queued} already open)` : ""),
);
