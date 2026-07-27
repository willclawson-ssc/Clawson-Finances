/**
 * Transaction management: detail, editing with an audit trail, and reversible merge.
 *
 * The organising idea is Will's data/metadata split, and it is enforced here rather than
 * left to convention:
 *
 *   DATA     — what the ledger currently believes. Editable. (date, amount, vendor,
 *              category, notes, …)
 *   METADATA — what actually arrived, and when. Immutable. (source, imported_*, the
 *              statement batch, external_ref, receipts)
 *
 * That split is what makes editing SAFE. The CSV dedup fingerprint is generated from the
 * imported_* snapshot (migration 0006), so correcting an amount can no longer change a
 * row's identity — which would otherwise make the next statement import fail to
 * recognise it and re-insert the original as a duplicate.
 */
import { sql } from "./db";

/**
 * Fields a user may change. An allowlist, not a denylist: a PATCH body is user input, and
 * the columns deliberately absent (fingerprint, imported_*, source, occurrence_n,
 * external_ref) are the ones that would corrupt dedup or falsify provenance.
 */
export const EDITABLE_FIELDS = [
  "txn_date", "amount", "raw_description", "normalized_merchant", "canonical_store_id",
  "category_id", "account_id", "status", "notes", "purchased_by", "excluded_from_totals",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

const NUMERIC_FIELDS = new Set(["amount"]);
const UUID_FIELDS = new Set(["canonical_store_id", "category_id", "account_id"]);
const BOOL_FIELDS = new Set(["excluded_from_totals"]);
const DATE_FIELDS = new Set(["txn_date"]);
const STATUSES = new Set(["posted", "pending", "scheduled"]);

export interface TransactionDetail {
  id: string;
  display_id: string;
  txn_date: string;
  post_date: string | null;
  amount: string;
  raw_description: string;
  normalized_merchant: string;
  status: string;
  notes: string | null;
  purchased_by: string | null;
  excluded_from_totals: boolean;
  account_id: string;
  account_name: string;
  category_id: string | null;
  category_name: string | null;
  category_source: string | null;
  canonical_store_id: string | null;
  store_name: string | null;
  store_kind: string | null;
  // ── metadata (immutable) ──
  source: string;
  imported_txn_date: string | null;
  imported_amount: string | null;
  imported_description: string | null;
  bank_category: string | null;
  source_category: string | null;
  txn_type: string | null;
  external_ref: string | null;
  occurrence_n: number;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  import_filename: string | null;
  import_adapter: string | null;
  imported_at: string | null;
  merged_into_id: string | null;
  merged_into_display_id: string | null;
}

/**
 * Accepts either the uuid or the human TXN-000123 handle — both are unique.
 *
 * The uuid parameter is passed as NULL when the input isn't uuid-shaped: casting an
 * arbitrary string to ::uuid raises rather than returning false, and a NULL comparison
 * simply doesn't match, which is the behaviour wanted here.
 */
export async function getTransaction(idOrDisplay: string): Promise<TransactionDetail | null> {
  const asUuid = /^[0-9a-f-]{36}$/i.test(idOrDisplay) ? idOrDisplay : null;
  const rows = (await sql.query(`
    SELECT t.id, t.display_id, t.txn_date::text AS txn_date, t.post_date::text AS post_date,
           t.amount::text AS amount, t.raw_description, t.normalized_merchant,
           t.status::text AS status, t.notes, t.purchased_by, t.excluded_from_totals,
           t.account_id, a.name AS account_name,
           t.category_id, c.name AS category_name, t.category_source,
           t.canonical_store_id, s.name AS store_name, s.kind::text AS store_kind,
           t.source::text AS source,
           t.imported_txn_date::text AS imported_txn_date,
           t.imported_amount::text AS imported_amount, t.imported_description,
           t.bank_category, t.source_category, t.txn_type, t.external_ref, t.occurrence_n,
           t.fingerprint, t.created_at::text AS created_at, t.updated_at::text AS updated_at,
           si.filename AS import_filename, si.adapter AS import_adapter,
           si.imported_at::text AS imported_at,
           t.merged_into_id, m.display_id AS merged_into_display_id
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN canonical_stores s ON s.id = t.canonical_store_id
    LEFT JOIN statement_imports si ON si.id = t.statement_import_id
    LEFT JOIN transactions m ON m.id = t.merged_into_id
    WHERE t.id = $1::uuid OR t.display_id = $2
  `, [asUuid, idOrDisplay])) as TransactionDetail[];
  return rows[0] ?? null;
}

export interface EditRow { field: string; old_value: string | null; new_value: string | null; edited_by: string | null; note: string | null; edited_at: string }

export async function getEditHistory(txnId: string): Promise<EditRow[]> {
  return (await sql`
    SELECT field, old_value, new_value, edited_by, note, edited_at::text AS edited_at
    FROM transaction_edits WHERE transaction_id = ${txnId}::uuid
    ORDER BY edited_at DESC
  `) as EditRow[];
}

export interface ReceiptRow {
  id: string; kind: string; blob_url: string | null; mime_type: string | null;
  byte_size: number | null; email_from: string | null; email_to: string | null;
  email_subject: string | null; received_at: string | null; parsed: unknown;
}

export async function getReceipts(txnId: string): Promise<ReceiptRow[]> {
  return (await sql`
    SELECT id, kind::text AS kind, blob_url, mime_type, byte_size,
           email_from, email_to, email_subject, received_at::text AS received_at, parsed
    FROM receipts WHERE transaction_id = ${txnId}::uuid ORDER BY created_at
  `) as ReceiptRow[];
}

/** Rows merged INTO this one — shown on the survivor's page so a merge is visible. */
export async function getMergedInto(txnId: string) {
  return (await sql`
    SELECT tm.id AS merge_id, tm.reason, tm.merged_at::text AS merged_at, tm.merged_by,
           t.id, t.display_id, t.txn_date::text AS txn_date, t.amount::text AS amount,
           t.raw_description, t.source::text AS source
    FROM transaction_merges tm
    JOIN transactions t ON t.id = tm.merged_id
    WHERE tm.survivor_id = ${txnId}::uuid AND tm.undone_at IS NULL
    ORDER BY tm.merged_at DESC
  `) as Record<string, string>[];
}

function coerce(field: EditableField, raw: unknown): string | number | boolean | null {
  if (raw === null || raw === "") return field === "amount" || field === "txn_date" ? null : null;
  if (BOOL_FIELDS.has(field)) return raw === true || raw === "true";
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${field}: not a number`);
    return n;
  }
  const s = String(raw).trim();
  if (DATE_FIELDS.has(field) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${field}: expected YYYY-MM-DD`);
  if (UUID_FIELDS.has(field) && !/^[0-9a-f-]{36}$/i.test(s)) throw new Error(`${field}: expected a uuid`);
  if (field === "status" && !STATUSES.has(s)) throw new Error(`status: must be posted|pending|scheduled`);
  return s;
}

export interface ApplyEditsResult { changed: string[]; skipped: string[] }

/**
 * Apply a partial update and record one audit row per field that actually changed.
 *
 * Fields whose value is unchanged are skipped rather than logged, so the history stays a
 * record of real decisions instead of a log of every time someone opened the form and
 * pressed Save.
 */
export async function applyEdits(
  txnId: string,
  patch: Record<string, unknown>,
  editedBy: string | null,
  note?: string,
): Promise<ApplyEditsResult> {
  // Column list comes from the EDITABLE_FIELDS constant, never from the request.
  const before = (await sql.query(
    `SELECT ${EDITABLE_FIELDS.join(", ")} FROM transactions WHERE id = $1::uuid`,
    [txnId],
  )) as Record<string, unknown>[];
  if (!before.length) throw new Error("transaction not found");
  const current = before[0];

  const changed: string[] = [];
  const skipped: string[] = [];

  for (const key of Object.keys(patch)) {
    if (!EDITABLE_FIELDS.includes(key as EditableField)) { skipped.push(key); continue; }
    const field = key as EditableField;
    const next = coerce(field, patch[key]);

    const prev = current[field] ?? null;
    // Normalize both sides before comparing. The driver returns numerics as strings and
    // dates as Date objects, so a naive comparison reports a change every time: Postgres
    // says "-30.00" where the form posts "-30", and they are the same number. Left
    // unhandled this writes a phantom audit row on every save — caught by
    // scripts/transactions.test.mts, not by any unit test.
    const prevStr = prev === null ? null
      : prev instanceof Date ? prev.toISOString().slice(0, 10)
      : String(prev);
    const nextStr = next === null ? null : String(next);
    const unchanged = NUMERIC_FIELDS.has(field)
      ? Number(prevStr) === Number(nextStr)
      : prevStr === nextStr;
    if (unchanged) { skipped.push(field); continue; }

    // Field name is from the allowlist above, never from user input.
    await sql.query(
      `UPDATE transactions SET ${field} = $1 WHERE id = $2::uuid`,
      [next, txnId],
    );
    await sql`
      INSERT INTO transaction_edits (transaction_id, field, old_value, new_value, edited_by, note)
      VALUES (${txnId}::uuid, ${field}, ${prevStr}, ${nextStr}, ${editedBy}, ${note ?? null})
    `;
    changed.push(field);
  }

  // A human touching the category outranks a rule or an LLM guess, and the cascade must
  // never re-decide it later (docs §5, the feedback loop).
  if (changed.includes("category_id")) {
    await sql`UPDATE transactions SET category_source = 'human' WHERE id = ${txnId}::uuid`;
  }

  return { changed, skipped };
}

export interface MergeCandidate {
  id: string; display_id: string; txn_date: string; amount: string;
  raw_description: string; source: string; account_name: string; store_name: string | null;
  day_gap: number; same_amount: boolean;
}

/**
 * Propose duplicates of a transaction.
 *
 * Tuned for the case that actually exists in this ledger: ~2,668 sheet rows that describe
 * the same purchase as a CSV row (docs §2e). Same account, amount within a cent, date
 * within a week. Deliberately does NOT require the merchant strings to look alike — the
 * whole reason those pairs exist is that the two sources describe vendors differently
 * ("Aldi" vs "ALDI BOSSIER CITY"); requiring similarity would hide exactly the duplicates
 * we are hunting. Vendor agreement is surfaced as a signal, not used as a filter.
 */
export async function mergeCandidates(txnId: string, dayWindow = 7): Promise<MergeCandidate[]> {
  return (await sql`
    WITH me AS (SELECT * FROM transactions WHERE id = ${txnId}::uuid)
    SELECT t.id, t.display_id, t.txn_date::text AS txn_date, t.amount::text AS amount,
           t.raw_description, t.source::text AS source, a.name AS account_name,
           s.name AS store_name,
           abs(t.txn_date - me.txn_date) AS day_gap,
           (t.amount = me.amount) AS same_amount
    FROM transactions t
    JOIN me ON true
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN canonical_stores s ON s.id = t.canonical_store_id
    WHERE t.id <> me.id
      AND t.merged_into_id IS NULL
      AND t.account_id = me.account_id
      AND abs(t.amount - me.amount) <= 0.01
      AND abs(t.txn_date - me.txn_date) <= ${dayWindow}
    ORDER BY (t.canonical_store_id IS NOT DISTINCT FROM me.canonical_store_id) DESC,
             abs(t.txn_date - me.txn_date), t.txn_date
    LIMIT 25
  `) as MergeCandidate[];
}

/**
 * Merge `loserId` into `survivorId`.
 *
 * The loser is never deleted — it keeps its id, its display_id and its provenance and
 * simply points at the survivor. Every read path filters merged_into_id IS NULL, so undo
 * is one UPDATE and "where did TXN-004821 go?" stays answerable forever.
 *
 * The survivor inherits only what it is MISSING (a category, notes, a receipt). A merge
 * should never silently overwrite a value the survivor already had; the pre-merge state
 * is snapshotted regardless so undo is exact.
 */
export async function mergeTransactions(
  survivorId: string,
  loserId: string,
  mergedBy: string | null,
  reason?: string,
): Promise<{ mergeId: string; adopted: string[] }> {
  if (survivorId === loserId) throw new Error("cannot merge a transaction into itself");

  const rows = (await sql`
    SELECT id, category_id, category_source, notes, purchased_by, merged_into_id
    FROM transactions WHERE id IN (${survivorId}::uuid, ${loserId}::uuid)
  `) as Record<string, string | null>[];
  const survivor = rows.find((r) => r.id === survivorId);
  const loser = rows.find((r) => r.id === loserId);
  if (!survivor || !loser) throw new Error("transaction not found");
  if (loser.merged_into_id) throw new Error("that transaction is already merged");
  if (survivor.merged_into_id) throw new Error("cannot merge into an already-merged transaction");

  const snapshot = (await sql`
    SELECT to_jsonb(t) AS row FROM transactions t WHERE t.id = ${survivorId}::uuid
  `) as { row: unknown }[];

  const adopted: string[] = [];
  if (!survivor.category_id && loser.category_id) {
    await sql`
      UPDATE transactions
      SET category_id = ${loser.category_id}::uuid,
          category_source = ${loser.category_source ?? "human"}
      WHERE id = ${survivorId}::uuid
    `;
    adopted.push("category_id");
  }
  if (!survivor.notes && loser.notes) {
    await sql`UPDATE transactions SET notes = ${loser.notes} WHERE id = ${survivorId}::uuid`;
    adopted.push("notes");
  }
  if (!survivor.purchased_by && loser.purchased_by) {
    await sql`UPDATE transactions SET purchased_by = ${loser.purchased_by} WHERE id = ${survivorId}::uuid`;
    adopted.push("purchased_by");
  }

  // Receipts and line items follow the surviving transaction, or they would be orphaned
  // behind a row nothing displays.
  await sql`UPDATE receipts SET transaction_id = ${survivorId}::uuid WHERE transaction_id = ${loserId}::uuid`;
  await sql`UPDATE line_items SET transaction_id = ${survivorId}::uuid WHERE transaction_id = ${loserId}::uuid`;

  await sql`
    UPDATE transactions SET merged_into_id = ${survivorId}::uuid, excluded_from_totals = true
    WHERE id = ${loserId}::uuid
  `;

  const merge = (await sql`
    INSERT INTO transaction_merges (survivor_id, merged_id, reason, merged_by, survivor_snapshot)
    VALUES (${survivorId}::uuid, ${loserId}::uuid, ${reason ?? null}, ${mergedBy},
            ${JSON.stringify(snapshot[0]?.row ?? null)}::jsonb)
    RETURNING id
  `) as { id: string }[];

  return { mergeId: merge[0].id, adopted };
}

/** Undo a merge: the loser returns to the ledger and the survivor's adopted fields revert. */
export async function unmergeTransactions(mergeId: string): Promise<void> {
  const rows = (await sql`
    SELECT survivor_id, merged_id, survivor_snapshot
    FROM transaction_merges WHERE id = ${mergeId}::uuid AND undone_at IS NULL
  `) as { survivor_id: string; merged_id: string; survivor_snapshot: Record<string, unknown> | null }[];
  if (!rows.length) throw new Error("merge not found or already undone");
  const { survivor_id, merged_id, survivor_snapshot } = rows[0];

  await sql`
    UPDATE transactions SET merged_into_id = NULL, excluded_from_totals = false
    WHERE id = ${merged_id}::uuid
  `;

  if (survivor_snapshot) {
    const s = survivor_snapshot as Record<string, string | null>;
    await sql`
      UPDATE transactions
      SET category_id = ${s.category_id}::uuid, category_source = ${s.category_source},
          notes = ${s.notes}, purchased_by = ${s.purchased_by}
      WHERE id = ${survivor_id}::uuid
    `;
  }

  await sql`UPDATE transaction_merges SET undone_at = now() WHERE id = ${mergeId}::uuid`;
}
