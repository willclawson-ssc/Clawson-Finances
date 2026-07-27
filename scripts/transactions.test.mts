/**
 * Integration tests for editing and merging, against the live Neon database.
 *
 * Unit tests cannot cover these: the behaviour under test IS the SQL — the audit trail,
 * the adoption rules on merge, and the fact that a merge is reversible.
 *
 * SAFETY: every test creates its own throwaway transactions in a dedicated scratch
 * account and deletes them (plus their cascaded edit/merge rows) afterwards. It never
 * touches the 8,970 real rows. Run: npm run test:db
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { applyEdits, mergeTransactions, unmergeTransactions, getTransaction, mergeCandidates } from "../src/lib/transactions";

const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const SCRATCH = "__test scratch account__";
let accountId = "";
let groceriesId = "";
const made: string[] = [];

async function mkTxn(o: { amount: number; date: string; desc: string; source?: string; category?: string | null; notes?: string | null }) {
  const r = (await sql`
    INSERT INTO transactions (account_id, txn_date, raw_description, normalized_merchant,
      amount, source, category_id, notes, imported_txn_date, imported_amount, imported_description)
    VALUES (${accountId}::uuid, ${o.date}::date, ${o.desc}, ${o.desc.toUpperCase()},
            ${o.amount}, ${(o.source ?? "manual")}::txn_source, ${o.category ?? null}::uuid,
            ${o.notes ?? null}, ${o.date}::date, ${o.amount}, ${o.desc})
    RETURNING id, display_id
  `) as { id: string; display_id: string }[];
  made.push(r[0].id);
  return r[0];
}

before(async () => {
  const a = (await sql`
    INSERT INTO accounts (name, institution, type, supports_csv, active)
    VALUES (${SCRATCH}, 'test', 'liability', false, false)
    ON CONFLICT (name) DO UPDATE SET institution = 'test'
    RETURNING id
  `) as { id: string }[];
  accountId = a[0].id;
  const c = (await sql`SELECT id FROM categories WHERE name = 'Food (Groceries)'`) as { id: string }[];
  groceriesId = c[0].id;
});

after(async () => {
  if (made.length) {
    await sql.query(`DELETE FROM transactions WHERE id = ANY($1::uuid[])`, [made]);
  }
  await sql`DELETE FROM accounts WHERE name = ${SCRATCH}`;
});

test("every transaction gets a unique sequential display id", async () => {
  const a = await mkTxn({ amount: -10, date: "2026-07-01", desc: "alpha" });
  const b = await mkTxn({ amount: -11, date: "2026-07-01", desc: "beta" });
  assert.match(a.display_id, /^TXN-\d{6}$/);
  assert.notEqual(a.display_id, b.display_id);
});

test("a transaction is fetchable by display id as well as uuid", async () => {
  const t = await mkTxn({ amount: -12, date: "2026-07-02", desc: "gamma" });
  const byUuid = await getTransaction(t.id);
  const byDisplay = await getTransaction(t.display_id);
  assert.equal(byUuid?.id, t.id);
  assert.equal(byDisplay?.id, t.id);
  assert.equal(await getTransaction("TXN-999999"), null);
});

test("editing writes one audit row per changed field", async () => {
  const t = await mkTxn({ amount: -20, date: "2026-07-03", desc: "delta" });
  const res = await applyEdits(t.id, { amount: -25.5, notes: "corrected" }, "user_test", "unit test");
  assert.deepEqual(res.changed.sort(), ["amount", "notes"]);

  const edits = (await sql`
    SELECT field, old_value, new_value, edited_by FROM transaction_edits
    WHERE transaction_id = ${t.id}::uuid ORDER BY field
  `) as Record<string, string>[];
  assert.equal(edits.length, 2);
  assert.equal(edits[0].field, "amount");
  assert.equal(edits[0].old_value, "-20.00");
  assert.equal(edits[0].new_value, "-25.5");
  assert.equal(edits[0].edited_by, "user_test");
});

test("an unchanged field is skipped, not logged", async () => {
  const t = await mkTxn({ amount: -30, date: "2026-07-04", desc: "epsilon" });
  const res = await applyEdits(t.id, { amount: -30, notes: null }, "user_test");
  assert.deepEqual(res.changed, [], "saving without changing anything must log nothing");
});

test("editing an amount does NOT change the dedup fingerprint", async () => {
  // The whole point of the imported_* snapshot: a correction must not make the next
  // statement import treat the row as new and re-insert the original.
  const t = await mkTxn({ amount: -40, date: "2026-07-05", desc: "zeta" });
  const before = (await sql`SELECT fingerprint FROM transactions WHERE id = ${t.id}::uuid`) as { fingerprint: string }[];
  await applyEdits(t.id, { amount: -99.99, txn_date: "2026-07-09" }, "user_test");
  const after = (await sql`SELECT fingerprint FROM transactions WHERE id = ${t.id}::uuid`) as { fingerprint: string }[];
  assert.equal(after[0].fingerprint, before[0].fingerprint);
});

test("setting a category by hand marks it human-sourced", async () => {
  const t = await mkTxn({ amount: -50, date: "2026-07-06", desc: "eta" });
  await applyEdits(t.id, { category_id: groceriesId }, "user_test");
  const got = await getTransaction(t.id);
  assert.equal(got?.category_source, "human", "a human decision must outrank rules and the LLM");
});

test("rejects unknown fields and bad values", async () => {
  const t = await mkTxn({ amount: -60, date: "2026-07-07", desc: "theta" });
  const res = await applyEdits(t.id, { fingerprint: "hacked", source: "csv" }, "user_test");
  assert.deepEqual(res.changed, [], "non-editable fields must be ignored");
  assert.deepEqual(res.skipped.sort(), ["fingerprint", "source"]);
  await assert.rejects(() => applyEdits(t.id, { txn_date: "not-a-date" }, "u"), /YYYY-MM-DD/);
  await assert.rejects(() => applyEdits(t.id, { status: "invented" }, "u"), /posted\|pending\|scheduled/);
});

test("merge candidates find the same amount on the same account within the window", async () => {
  const a = await mkTxn({ amount: -77.77, date: "2026-07-10", desc: "iota one" });
  await mkTxn({ amount: -77.77, date: "2026-07-12", desc: "iota two", source: "csv" });
  await mkTxn({ amount: -77.77, date: "2026-08-30", desc: "iota far" });
  await mkTxn({ amount: -12.34, date: "2026-07-12", desc: "iota other amount" });

  const cands = await mergeCandidates(a.id);
  const ids = cands.map((c) => c.raw_description);
  assert.ok(ids.includes("iota two"), "same amount, 2 days apart");
  assert.ok(!ids.includes("iota far"), "outside the date window");
  assert.ok(!ids.includes("iota other amount"), "different amount");
});

test("merge hides the loser, keeps its id, and adopts only missing fields", async () => {
  const survivor = await mkTxn({ amount: -88, date: "2026-07-15", desc: "kappa csv", source: "csv", notes: "keep me" });
  const loser = await mkTxn({ amount: -88, date: "2026-07-15", desc: "kappa sheet", category: groceriesId, notes: "do not steal" });

  const { mergeId, adopted } = await mergeTransactions(survivor.id, loser.id, "user_test", "test merge");
  assert.deepEqual(adopted, ["category_id"], "adopts the missing category but not the existing notes");

  const s = await getTransaction(survivor.id);
  const l = await getTransaction(loser.id);
  assert.equal(s?.category_id, groceriesId);
  assert.equal(s?.notes, "keep me", "must not overwrite a value the survivor already had");
  assert.equal(l?.merged_into_id, survivor.id);
  assert.equal(l?.display_id.startsWith("TXN-"), true, "the loser keeps its identity");

  // Hidden from the ledger, but still present in the table.
  const visible = (await sql`
    SELECT count(*)::int AS n FROM transactions
    WHERE id = ${loser.id}::uuid AND merged_into_id IS NULL
  `) as { n: number }[];
  assert.equal(visible[0].n, 0);

  await unmergeTransactions(mergeId);
  const s2 = await getTransaction(survivor.id);
  const l2 = await getTransaction(loser.id);
  assert.equal(l2?.merged_into_id, null, "undo returns the row to the ledger");
  assert.equal(s2?.category_id, null, "undo reverts what the merge adopted");
});

test("refuses nonsensical merges", async () => {
  const a = await mkTxn({ amount: -91, date: "2026-07-20", desc: "lambda a" });
  const b = await mkTxn({ amount: -91, date: "2026-07-20", desc: "lambda b" });
  await assert.rejects(() => mergeTransactions(a.id, a.id, "u"), /into itself/);

  const { mergeId } = await mergeTransactions(a.id, b.id, "u");
  await assert.rejects(() => mergeTransactions(a.id, b.id, "u"), /already merged/);
  await unmergeTransactions(mergeId);
  await assert.rejects(() => unmergeTransactions(mergeId), /already undone/);
});

/**
 * The exclusion flag and its reason must always agree — migration 0007 enforces it with a
 * CHECK, and a CHECK cannot be deferred in Postgres, so both columns have to move in one
 * statement. This is not hypothetical: adding the constraint broke merge immediately,
 * because merge excluded its loser without naming a reason.
 */
test("excluding a transaction by hand records the reason atomically", async () => {
  const t = await mkTxn({ amount: -75, date: "2026-07-18", desc: "manual exclusion" });

  await applyEdits(t.id, { excluded_from_totals: true }, "u");
  const [on] = (await sql`
    SELECT excluded_from_totals, exclusion_reason FROM transactions WHERE id = ${t.id}::uuid
  `) as { excluded_from_totals: boolean; exclusion_reason: string | null }[];
  assert.deepEqual(on, { excluded_from_totals: true, exclusion_reason: "manual" });

  await applyEdits(t.id, { excluded_from_totals: false }, "u");
  const [off] = (await sql`
    SELECT excluded_from_totals, exclusion_reason FROM transactions WHERE id = ${t.id}::uuid
  `) as { excluded_from_totals: boolean; exclusion_reason: string | null }[];
  assert.deepEqual(off, { excluded_from_totals: false, exclusion_reason: null },
    "clearing the flag must clear the reason, not orphan it");
});

test("merge marks its loser excluded as a duplicate", async () => {
  const survivor = await mkTxn({ amount: -60, date: "2026-07-19", desc: "dup survivor" });
  const loser = await mkTxn({ amount: -60, date: "2026-07-19", desc: "dup loser" });

  const { mergeId } = await mergeTransactions(survivor.id, loser.id, "u");
  const [merged] = (await sql`
    SELECT excluded_from_totals, exclusion_reason FROM transactions WHERE id = ${loser.id}::uuid
  `) as { excluded_from_totals: boolean; exclusion_reason: string | null }[];
  assert.deepEqual(merged, { excluded_from_totals: true, exclusion_reason: "duplicate" });

  await unmergeTransactions(mergeId);
  const [undone] = (await sql`
    SELECT excluded_from_totals, exclusion_reason FROM transactions WHERE id = ${loser.id}::uuid
  `) as { excluded_from_totals: boolean; exclusion_reason: string | null }[];
  assert.deepEqual(undone, { excluded_from_totals: false, exclusion_reason: null });
});

/**
 * The whole point of counted_transactions: the scratch account has supports_csv = false, so
 * its rows must survive the view's era filter regardless of date. This is the Dad's Checking
 * case that a plain `source = 'csv'` filter silently dropped $3,720 of.
 */
test("counted_transactions keeps rows for accounts with no CSV export", async () => {
  const t = await mkTxn({ amount: -42, date: "2026-07-23", desc: "no csv account row" });
  const [seen] = (await sql`
    SELECT count(*)::int AS n FROM counted_transactions WHERE id = ${t.id}::uuid
  `) as { n: number }[];
  assert.equal(seen.n, 1, "a CSV-era row on a non-CSV account must still count");
});
