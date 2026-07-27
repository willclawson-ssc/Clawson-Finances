import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import Papa from "papaparse";
import { sql } from "@/lib/db";
import {
  detectAdapter, parseRows, accountTypeWarning, type AccountType, type AdapterId,
} from "@/lib/adapters";
import { matchSettlements, type ExistingPending } from "@/lib/reconcile";
import { buildStoreIndex, resolveStore, type StoreAlias } from "@/lib/stores";

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
  const warning = accountTypeWarning(rows, account.name);

  // Settle anything still pending from a previous import BEFORE inserting. A restaurant
  // authorization re-exports as Posted at a different amount once the tip lands, which is
  // a different fingerprint — so without this step the meal is inserted a second time and
  // the stale pending row never goes away. See src/lib/reconcile.ts.
  const pending = (await sql`
    SELECT id, txn_date::text AS txn_date, raw_description, normalized_merchant,
           amount::text AS amount, status::text AS status
    FROM transactions
    WHERE account_id = ${accountId}::uuid AND status <> 'posted'
  `) as ExistingPending[];
  const { settlements, fresh } = matchSettlements(rows, pending);

  // Resolve each descriptor to a canonical vendor by longest match, so "THE HOME DEPOT
  // 1234 SOMEWHERE" lands on The Home Depot without any stripping rule having to guess
  // which trailing digits belong to the brand. Unresolved rows are a genuinely new
  // vendor and are reported, not silently left blank.
  const aliases = (await sql`
    SELECT pattern, store_id AS "storeId" FROM store_aliases
  `) as StoreAlias[];
  const storeIdx = buildStoreIndex(aliases);
  const storeIds = fresh.map((r) => resolveStore(r.normalizedMerchant, storeIdx));
  const unresolved = [
    ...new Set(fresh.filter((_, i) => !storeIds[i]).map((r) => r.normalizedMerchant)),
  ];

  const importRows = (await sql`
    INSERT INTO statement_imports (account_id, adapter, filename, row_count, range_start, range_end)
    VALUES (${accountId}::uuid, ${adapter}, ${file.name}, ${rows.length},
            ${dates[0]}::date, ${dates[dates.length - 1]}::date)
    RETURNING id
  `) as { id: string }[];
  const importId = importRows[0].id;

  // Apply settlements in place. The fingerprint is a generated column, so updating the
  // amount/date recomputes it — which can collide with a posted row already present if
  // the same statement is imported twice. In that case the pending row is simply
  // superseded and gets deleted rather than left as a phantom charge.
  let settled = 0;
  for (const s of settlements) {
    try {
      await sql`
        UPDATE transactions
        SET txn_date = ${s.row.txnDate}::date, post_date = ${s.row.postDate}::date,
            raw_description = ${s.row.rawDescription},
            normalized_merchant = ${s.row.normalizedMerchant},
            amount = ${s.row.amount}, status = 'posted'::txn_status,
            bank_category = ${s.row.bankCategory}, statement_import_id = ${importId}::uuid
        WHERE id = ${s.pendingId}::uuid
      `;
    } catch (e) {
      if (!String(e).includes("transactions_fingerprint_csv_key")) throw e;
      await sql`DELETE FROM transactions WHERE id = ${s.pendingId}::uuid`;
    }
    settled++;
  }

  // Idempotent re-import. ON CONFLICT targets the PARTIAL unique index on fingerprint
  // (source = 'csv'), so re-uploading an overlapping date range inserts nothing new,
  // while genuine same-day same-amount repeats still land because the fingerprint
  // includes an occurrence ordinal.
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const chunk = fresh.slice(i, i + CHUNK);
    const chunkStores = storeIds.slice(i, i + CHUNK);
    const result = (await sql.query(
      `INSERT INTO transactions
         (account_id, txn_date, post_date, raw_description, normalized_merchant,
          amount, status, source, bank_category, purchased_by, txn_type, occurrence_n,
          canonical_store_id, statement_import_id)
       SELECT $1::uuid, d.txn_date, d.post_date, d.raw_description, d.normalized_merchant,
              d.amount, d.status::txn_status, 'csv'::txn_source, d.bank_category,
              d.purchased_by, d.txn_type, d.occurrence_n, d.store_id::uuid, $2::uuid
       FROM unnest(
              $3::date[], $4::date[], $5::text[], $6::text[], $7::numeric[],
              $8::text[], $9::text[], $10::text[], $11::text[], $12::smallint[],
              $13::text[]
            ) AS d(txn_date, post_date, raw_description, normalized_merchant, amount,
                   status, bank_category, purchased_by, txn_type, occurrence_n, store_id)
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
        chunk.map((r) => r.txnType),
        chunk.map((r) => r.occurrenceN),
        chunkStores,
      ],
    )) as unknown[];
    inserted += Array.isArray(result) ? result.length : 0;
  }

  const duplicates = fresh.length - inserted;
  await sql`
    UPDATE statement_imports
    SET inserted_count = ${inserted}, updated_count = ${settled},
        skipped_count = ${duplicates + skipped.length}
    WHERE id = ${importId}::uuid
  `;

  return NextResponse.json({
    adapter,
    account: account.name,
    parsed: rows.length,
    settled,
    warning,
    newVendors: unresolved,
    inserted,
    duplicates,
    unparseable: skipped.length,
    range: { from: dates[0], to: dates[dates.length - 1] },
  });
}
