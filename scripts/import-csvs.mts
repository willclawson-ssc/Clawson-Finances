/**
 * Load the four real statement exports into Neon, using the same adapters + SQL as the
 * app's upload route (src/app/api/import/route.ts) so this is a batch of that path, not
 * a second implementation of it.
 *
 * The account is passed EXPLICITLY per file and never inferred: both USAA exports are
 * named bk_download.csv with an identical header, and nothing inside identifies which
 * account they came from. Guessing wrong inverts the sign of every row (docs §3).
 *
 * These rows overlap the sheet history for 2025-01-25 → 2026-07-24. That is accepted:
 * Will's call is to load everything and reconcile automatically later (docs §2e).
 *
 * Run: npx tsx scripts/import-csvs.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Papa from "papaparse";
import { neon } from "@neondatabase/serverless";
import { detectAdapter, parseRows } from "../src/lib/adapters";

const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const dir = path.join(os.homedir(), "docker/finances-app/samples");

const FILES: { file: string; account: string }[] = [
  { file: "usaa-sample-A.csv", account: "USAA Checking" },
  { file: "usaa-sample-B.csv", account: "USAA Credit Card" },
  { file: "discover-sample.csv", account: "Discover" },
  { file: "applecard-sample.csv", account: "Apple Card" },
];

const accounts = (await sql`SELECT id, name, type::text AS type FROM accounts`) as
  { id: string; name: string; type: "asset" | "liability" }[];

for (const { file, account } of FILES) {
  const acct = accounts.find((a) => a.name === account);
  if (!acct) throw new Error(`account not found: ${account}`);

  const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(path.join(dir, file), "utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  const adapter = detectAdapter(parsed.meta.fields ?? []);
  if (!adapter) throw new Error(`unrecognized format: ${file}`);

  const { rows, skipped } = parseRows(parsed.data, adapter, acct.type);
  const dates = rows.map((r) => r.txnDate).sort();

  const imp = (await sql`
    INSERT INTO statement_imports (account_id, adapter, filename, row_count, range_start, range_end)
    VALUES (${acct.id}::uuid, ${adapter}, ${file}, ${rows.length},
            ${dates[0]}::date, ${dates[dates.length - 1]}::date)
    RETURNING id
  `) as { id: string }[];

  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const c = rows.slice(i, i + CHUNK);
    const res = (await sql.query(
      `INSERT INTO transactions
         (account_id, txn_date, post_date, raw_description, normalized_merchant,
          amount, status, source, bank_category, purchased_by, occurrence_n,
          statement_import_id)
       SELECT $1::uuid, d.txn_date, d.post_date, d.raw_description, d.normalized_merchant,
              d.amount, d.status::txn_status, 'csv'::txn_source, d.bank_category,
              d.purchased_by, d.occurrence_n, $2::uuid
       FROM unnest($3::date[], $4::date[], $5::text[], $6::text[], $7::numeric[],
                   $8::text[], $9::text[], $10::text[], $11::smallint[])
            AS d(txn_date, post_date, raw_description, normalized_merchant, amount,
                 status, bank_category, purchased_by, occurrence_n)
       ON CONFLICT (fingerprint) WHERE source = 'csv' DO NOTHING
       RETURNING 1`,
      [
        acct.id, imp[0].id,
        c.map((r) => r.txnDate), c.map((r) => r.postDate), c.map((r) => r.rawDescription),
        c.map((r) => r.normalizedMerchant), c.map((r) => r.amount), c.map((r) => r.status),
        c.map((r) => r.bankCategory), c.map((r) => r.purchasedBy), c.map((r) => r.occurrenceN),
      ],
    )) as unknown[];
    inserted += Array.isArray(res) ? res.length : 0;
  }

  await sql`
    UPDATE statement_imports
    SET inserted_count = ${inserted}, skipped_count = ${rows.length - inserted + skipped.length}
    WHERE id = ${imp[0].id}::uuid
  `;

  console.log(
    `${file.padEnd(22)} ${adapter.padEnd(10)} → ${account.padEnd(17)} ` +
    `parsed ${String(rows.length).padStart(5)}  inserted ${String(inserted).padStart(5)}  ` +
    `dup ${rows.length - inserted}  unparseable ${skipped.length}  ${dates[0]} → ${dates[dates.length - 1]}`,
  );
}
