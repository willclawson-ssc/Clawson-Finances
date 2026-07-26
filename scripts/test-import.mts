/**
 * End-to-end check of the import path against the REAL USAA card export, exercising the
 * same SQL the API route uses — including the ordinal-aware ON CONFLICT.
 *
 * Verifies the property that matters most: importing the SAME file twice must insert
 * nothing the second time, while genuine same-day/same-amount repeats survive the first.
 *
 * Cleans up after itself. Run: npx tsx scripts/test-import.ts <accountId>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Papa from "papaparse";
import { neon } from "@neondatabase/serverless";
import { detectAdapter, parseRows } from "../src/lib/adapters";

const accountId = process.argv[2];
if (!accountId) throw new Error("usage: tsx scripts/test-import.ts <accountId>");

const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const file = path.join(os.homedir(), "docker/finances-app/samples/usaa-sample-B.csv");

const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(file, "utf8"), {
  header: true,
  skipEmptyLines: true,
});
const adapter = detectAdapter(parsed.meta.fields ?? [])!;
const { rows } = parseRows(parsed.data, adapter, "liability");
console.log(`parsed ${rows.length} rows via '${adapter}'`);

async function importOnce(label: string): Promise<number> {
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const c = rows.slice(i, i + CHUNK);
    const res = (await sql.query(
      `INSERT INTO transactions
         (account_id, txn_date, post_date, raw_description, normalized_merchant,
          amount, status, source, bank_category, purchased_by, occurrence_n)
       SELECT $1::uuid, d.txn_date, d.post_date, d.raw_description, d.normalized_merchant,
              d.amount, d.status::txn_status, 'csv'::txn_source, d.bank_category,
              d.purchased_by, d.occurrence_n
       FROM unnest($2::date[], $3::date[], $4::text[], $5::text[], $6::numeric[],
                   $7::text[], $8::text[], $9::text[], $10::smallint[])
            AS d(txn_date, post_date, raw_description, normalized_merchant, amount,
                 status, bank_category, purchased_by, occurrence_n)
       ON CONFLICT (fingerprint) WHERE source = 'csv' DO NOTHING
       RETURNING 1`,
      [
        accountId,
        c.map((r) => r.txnDate),
        c.map((r) => r.postDate),
        c.map((r) => r.rawDescription),
        c.map((r) => r.normalizedMerchant),
        c.map((r) => r.amount),
        c.map((r) => r.status),
        c.map((r) => r.bankCategory),
        c.map((r) => r.purchasedBy),
        c.map((r) => r.occurrenceN),
      ],
    )) as unknown[];
    inserted += Array.isArray(res) ? res.length : 0;
  }
  console.log(`${label}: inserted ${inserted}`);
  return inserted;
}

let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

const first = await importOnce("first import");
const second = await importOnce("second import (same file)");

check(first === rows.length, `first import inserted all ${rows.length} rows`);
check(second === 0, "re-import inserted 0 rows (idempotent)");

// The duplicate case that would break a naive fingerprint.
const anthropic = (await sql`
  SELECT amount::text AS amount, occurrence_n
  FROM transactions
  WHERE account_id = ${accountId}::uuid
    AND normalized_merchant LIKE 'ANTHROPIC%' AND txn_date = '2026-06-14'
  ORDER BY amount, occurrence_n
`) as { amount: string; occurrence_n: number }[];
console.log(`  ANTHROPIC 2026-06-14 rows: ${anthropic.map((a) => `${a.amount}#${a.occurrence_n}`).join(", ")}`);
check(anthropic.length >= 4, "same-day duplicate ANTHROPIC charges all preserved");

const totals = (await sql`
  SELECT COUNT(*)::int AS n, SUM(amount)::text AS total
  FROM transactions WHERE account_id = ${accountId}::uuid
`) as { n: number; total: string }[];
console.log(`  stored ${totals[0].n} rows, net ${totals[0].total}`);
check(totals[0].n === rows.length, "stored row count matches parsed count");

/**
 * NOT asserting the net is negative — the real data disproved that (+$1,598.71 here).
 *
 * On a liability account the sum of normalized amounts is the BALANCE CHANGE, not
 * spending: card payments arrive as inflows and largely cancel the purchases, so a
 * period where the balance was paid down nets positive. Spending only becomes
 * measurable once transfers are detected and excluded (docs §3). Until then, no
 * "total spend" figure in this app is trustworthy.
 */
const outflow = (await sql`
  SELECT COUNT(*)::int AS n FROM transactions
  WHERE account_id = ${accountId}::uuid AND amount < 0
`) as { n: number }[];
check(outflow[0].n > rows.length / 2, "most rows are outflows (sign normalization correct)");

await sql`DELETE FROM transactions WHERE account_id = ${accountId}::uuid`;
console.log("cleaned up test rows");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
