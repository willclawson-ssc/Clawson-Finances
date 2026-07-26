/**
 * Load the "Clawson Finances" Google Sheet history into Neon.
 *
 * Decision (Will, 2026-07-26): load the WHOLE sheet — it is the source of truth — and
 * reconcile its overlap with the CSV exports automatically, later. So this script
 * deliberately does NOT try to avoid the ~3,000 rows that also exist in a bank export.
 * Those pairs are a known, recorded debt (docs §2e), not an accident.
 *
 * Idempotent via transactions.external_ref ('gsheet:<row>'), so it is safe to re-run
 * after a sheet edit or a partial failure.
 *
 * Export the tab first:  python3 ~/docker/finances-app/sheet-export.py \
 *   "Actual Income/Spending (Google Form Responses)" \
 *   ~/docker/finances-app/samples/sheet-form-responses.csv
 *
 * Run: npx tsx scripts/import-sheet.mts [--dry-run]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Papa from "papaparse";
import { neon } from "@neondatabase/serverless";
import { ACCOUNTS, parseSheetRows, type AccountKey } from "../src/lib/sheet";

const DRY = process.argv.includes("--dry-run");
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const FILE = path.join(os.homedir(), "docker/finances-app/samples/sheet-form-responses.csv");

const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(FILE, "utf8"), {
  header: true,
  skipEmptyLines: false, // blank rows are counted as skips, not silently dropped
});
const { rows, skipped } = parseSheetRows(parsed.data);

console.log(`parsed ${rows.length} rows, skipped ${skipped.length}`);
const skipReasons = new Map<string, number>();
for (const s of skipped) {
  const k = s.reason.replace(/".*"/, '"…"');
  skipReasons.set(k, (skipReasons.get(k) ?? 0) + 1);
}
for (const [r, n] of skipReasons) console.log(`  skip: ${n} × ${r}`);

const flagCounts = new Map<string, number>();
for (const r of rows) for (const f of r.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
for (const [f, n] of flagCounts) console.log(`  flag: ${n} × ${f}`);

if (DRY) {
  const byAccount = new Map<AccountKey, { n: number; min: string; max: string; sum: number }>();
  for (const r of rows) {
    const a = byAccount.get(r.accountKey) ?? { n: 0, min: r.txnDate, max: r.txnDate, sum: 0 };
    a.n++; a.sum += r.amount;
    if (r.txnDate < a.min) a.min = r.txnDate;
    if (r.txnDate > a.max) a.max = r.txnDate;
    byAccount.set(r.accountKey, a);
  }
  for (const [k, a] of byAccount) {
    console.log(`  ${ACCOUNTS[k].name.padEnd(18)} ${String(a.n).padStart(5)}  ${a.min} → ${a.max}  net ${a.sum.toFixed(2)}`);
  }
  console.log("dry run — nothing written");
  process.exit(0);
}

// ── accounts ─────────────────────────────────────────────────────────────────
// Upsert by name so re-running never forks an account, and so the pre-existing
// "USAA Credit Card" row keeps its id (the CSV import test already used it).
const accountIds = new Map<AccountKey, string>();
for (const [key, a] of Object.entries(ACCOUNTS) as [AccountKey, typeof ACCOUNTS[AccountKey]][]) {
  const r = (await sql`
    INSERT INTO accounts (name, institution, type, supports_csv, active)
    VALUES (${a.name}, ${a.institution}, ${a.type}::account_type, ${a.supportsCsv}, ${a.active})
    ON CONFLICT (name) DO UPDATE SET institution = EXCLUDED.institution
    RETURNING id
  `) as { id: string }[];
  accountIds.set(key, r[0].id);
}
console.log(`accounts ready: ${accountIds.size}`);

const cats = (await sql`SELECT id, name FROM categories`) as { id: string; name: string }[];
const catId = new Map(cats.map((c) => [c.name, c.id]));

// ── one statement_imports batch per account, for provenance + rollback ───────
const importIds = new Map<AccountKey, string>();
for (const key of new Set(rows.map((r) => r.accountKey))) {
  const mine = rows.filter((r) => r.accountKey === key).map((r) => r.txnDate).sort();
  const r = (await sql`
    INSERT INTO statement_imports (account_id, adapter, filename, row_count, range_start, range_end)
    VALUES (${accountIds.get(key)!}::uuid, 'gsheet', 'Actual Income/Spending (Google Form Responses)',
            ${mine.length}, ${mine[0]}::date, ${mine[mine.length - 1]}::date)
    RETURNING id
  `) as { id: string }[];
  importIds.set(key, r[0].id);
}

// ── transactions ─────────────────────────────────────────────────────────────
// category_source = 'human': every one of these was picked by Will in the Form. That
// provenance is what lets the rules seeder trust them and the LLM stage skip them.
let inserted = 0;
const insertedIds = new Map<string, string>(); // external_ref -> txn id
const CHUNK = 500;
for (let i = 0; i < rows.length; i += CHUNK) {
  const c = rows.slice(i, i + CHUNK);
  const res = (await sql.query(
    `INSERT INTO transactions
       (account_id, txn_date, raw_description, normalized_merchant, amount, status, source,
        source_category, category_id, category_source, notes, external_ref,
        statement_import_id)
     SELECT d.account_id::uuid, d.txn_date, d.raw_description, d.normalized_merchant,
            d.amount, 'posted'::txn_status, 'sheet'::txn_source, d.source_category,
            d.category_id::uuid,
            CASE WHEN d.category_id IS NOT NULL THEN 'human' END,
            d.notes, d.external_ref, d.import_id::uuid
     FROM unnest($1::text[], $2::date[], $3::text[], $4::text[], $5::numeric[], $6::text[],
                 $7::text[], $8::text[], $9::text[], $10::text[])
          AS d(account_id, txn_date, raw_description, normalized_merchant, amount,
               source_category, category_id, notes, external_ref, import_id)
     ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING id, external_ref`,
    [
      c.map((r) => accountIds.get(r.accountKey)!),
      c.map((r) => r.txnDate),
      c.map((r) => r.rawDescription),
      c.map((r) => r.normalizedMerchant),
      c.map((r) => r.amount),
      c.map((r) => r.sourceCategory),
      c.map((r) => (r.category ? catId.get(r.category) ?? null : null)),
      c.map((r) => r.notes),
      c.map((r) => `gsheet:${r.sheetRow}`),
      c.map((r) => importIds.get(r.accountKey)!),
    ],
  )) as { id: string; external_ref: string }[];
  for (const r of res) insertedIds.set(r.external_ref, r.id);
  inserted += res.length;
  process.stdout.write(`\r  inserted ${inserted}/${rows.length}`);
}
console.log("");

for (const [key, id] of importIds) {
  const mine = rows.filter((r) => r.accountKey === key);
  const ins = mine.filter((r) => insertedIds.has(`gsheet:${r.sheetRow}`)).length;
  await sql`
    UPDATE statement_imports SET inserted_count = ${ins}, skipped_count = ${mine.length - ins}
    WHERE id = ${id}::uuid
  `;
}

// ── review queue ─────────────────────────────────────────────────────────────
// Rows the importer would have had to GUESS about. Deliberately surfaced rather than
// resolved in code: 'inspection'/'home'/'business income' are not typos of anything, and
// four negative-amount rows filed as Income are refunds whose direction is ambiguous.
const flagged = rows.filter((r) => r.flags.length && insertedIds.has(`gsheet:${r.sheetRow}`));
let queued = 0;
for (const r of flagged) {
  const reason = r.flags.includes("unmapped_category")
    ? "unmapped_category"
    : r.flags.includes("negative_amount")
      ? "sign_check"
      : r.flags[0];
  await sql`
    INSERT INTO review_queue (transaction_id, reason, suggestion)
    VALUES (${insertedIds.get(`gsheet:${r.sheetRow}`)!}::uuid, ${reason},
            ${JSON.stringify({ sheetRow: r.sheetRow, flags: r.flags, sourceCategory: r.sourceCategory, rawDate: r.txnDate })}::jsonb)
  `;
  queued++;
}

console.log(`inserted ${inserted} (duplicates skipped ${rows.length - inserted}), queued ${queued} for review`);
