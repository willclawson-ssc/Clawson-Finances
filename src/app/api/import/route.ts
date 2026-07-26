import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import Papa from "papaparse";
import { sql } from "@/lib/db";
import { detectAdapter, parseRows, type AccountType, type AdapterId } from "@/lib/adapters";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  const accountId = String(form.get("accountId") ?? "");

  if (!(file instanceof File)) return NextResponse.json({ error: "no file uploaded" }, { status: 400 });
  if (!accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 });

  // The account must be chosen explicitly, never guessed. Both USAA exports are named
  // bk_download.csv with an identical header and nothing inside identifying the account;
  // only the sign pattern hints at it, and guessing wrong inverts every amount.
  const accounts = (await sql`
    SELECT id, name, type::text AS type FROM accounts WHERE id = ${accountId}::uuid
  `) as { id: string; name: string; type: AccountType }[];
  if (!accounts.length) return NextResponse.json({ error: "unknown account" }, { status: 404 });
  const account = accounts[0];

  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const adapter: AdapterId | null = detectAdapter(headers);
  if (!adapter) {
    return NextResponse.json(
      { error: `unrecognized CSV format. Columns seen: ${headers.join(", ")}` },
      { status: 422 },
    );
  }

  const { rows, skipped } = parseRows(parsed.data, adapter, account.type);
  if (!rows.length) {
    return NextResponse.json({ error: "no usable rows in file", skipped }, { status: 422 });
  }

  const dates = rows.map((r) => r.txnDate).sort();

  const importRows = (await sql`
    INSERT INTO statement_imports (account_id, adapter, filename, row_count, range_start, range_end)
    VALUES (${accountId}::uuid, ${adapter}, ${file.name}, ${rows.length},
            ${dates[0]}::date, ${dates[dates.length - 1]}::date)
    RETURNING id
  `) as { id: string }[];
  const importId = importRows[0].id;

  // Idempotent re-import. ON CONFLICT targets the PARTIAL unique index on fingerprint
  // (source = 'csv'), so re-uploading an overlapping date range inserts nothing new,
  // while genuine same-day same-amount repeats still land because the fingerprint
  // includes an occurrence ordinal.
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = (await sql.query(
      `INSERT INTO transactions
         (account_id, txn_date, post_date, raw_description, normalized_merchant,
          amount, status, source, bank_category, purchased_by, occurrence_n,
          statement_import_id)
       SELECT $1::uuid, d.txn_date, d.post_date, d.raw_description, d.normalized_merchant,
              d.amount, d.status::txn_status, 'csv'::txn_source, d.bank_category,
              d.purchased_by, d.occurrence_n, $2::uuid
       FROM unnest(
              $3::date[], $4::date[], $5::text[], $6::text[], $7::numeric[],
              $8::text[], $9::text[], $10::text[], $11::smallint[]
            ) AS d(txn_date, post_date, raw_description, normalized_merchant, amount,
                   status, bank_category, purchased_by, occurrence_n)
       ON CONFLICT (fingerprint) WHERE source = 'csv' DO NOTHING
       RETURNING 1`,
      [
        accountId,
        importId,
        chunk.map((r) => r.txnDate),
        chunk.map((r) => r.postDate),
        chunk.map((r) => r.rawDescription),
        chunk.map((r) => r.normalizedMerchant),
        chunk.map((r) => r.amount),
        chunk.map((r) => r.status),
        chunk.map((r) => r.bankCategory),
        chunk.map((r) => r.purchasedBy),
        chunk.map((r) => r.occurrenceN),
      ],
    )) as unknown[];
    inserted += Array.isArray(result) ? result.length : 0;
  }

  const duplicates = rows.length - inserted;
  await sql`
    UPDATE statement_imports
    SET inserted_count = ${inserted}, skipped_count = ${duplicates + skipped.length}
    WHERE id = ${importId}::uuid
  `;

  return NextResponse.json({
    adapter,
    account: account.name,
    parsed: rows.length,
    inserted,
    duplicates,
    unparseable: skipped.length,
    range: { from: dates[0], to: dates[dates.length - 1] },
  });
}
