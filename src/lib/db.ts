import { neon } from "@neondatabase/serverless";

/**
 * Neon HTTP client. Uses the POOLED connection string — the direct one is reserved for
 * migrations and the (future) home-server worker.
 *
 * ⚠️ Never add a health check, uptime probe or metrics scraper against this database.
 * Neon's free plan only stays within its 100 CU-hour budget because compute suspends
 * after 5 minutes idle. Anything touching the DB more often than that pins it awake for
 * ~730 h/month (~182 CU-hours) and the compute gets suspended mid-month. Monitor the
 * Vercel HTTP endpoint instead. See ~/docs/finances-app.md §2.
 */
let _client: ReturnType<typeof neon> | null = null;

function client(): ReturnType<typeof neon> {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _client = neon(url);
  }
  return _client;
}

/**
 * Lazily instantiated so the connection string is only required at REQUEST time.
 * Calling neon() at module scope made `next build` fail while collecting page data —
 * the build imports every route module, and DATABASE_URL isn't present in CI.
 */
export const sql = new Proxy((() => {}) as unknown as ReturnType<typeof neon>, {
  apply: (_t, _this, args: unknown[]) =>
    (client() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_t, prop: string | symbol) => {
    const c = client() as unknown as Record<string | symbol, unknown>;
    const v = c[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});

export interface Account {
  id: string;
  name: string;
  institution: string;
  type: "asset" | "liability";
  supports_csv: boolean;
  active: boolean;
}

export async function listAccounts(): Promise<Account[]> {
  return (await sql`
    SELECT id, name, institution, type, supports_csv, active
    FROM accounts WHERE active ORDER BY name
  `) as Account[];
}

export interface NamedRow {
  id: string;
  name: string;
}

export async function listCategories(): Promise<NamedRow[]> {
  return (await sql`SELECT id, name FROM categories WHERE active ORDER BY name`) as NamedRow[];
}

/** Canonical vendors, for the transaction detail page's store picker. */
export async function listStores(): Promise<NamedRow[]> {
  return (await sql`SELECT id, name FROM canonical_stores WHERE active ORDER BY name`) as NamedRow[];
}

export interface LedgerRow {
  id: string;
  display_id: string;
  txn_date: string;
  normalized_merchant: string;
  /** Canonical vendor name ("The Home Depot"), falling back to the normalized string. */
  store_name: string | null;
  raw_description: string;
  amount: string;
  status: string;
  source: string;
  account_name: string;
  category_name: string | null;
}

/**
 * ⚠️ `txn_date::text` is REQUIRED, not cosmetic. The driver decodes a bare `date` column
 * into a JS Date object, and page.tsx renders the field directly — React then throws
 * "Objects are not valid as a React child" and the whole route fails to render, which
 * looks to the user like a broken login.
 *
 * The empty ledger hid this: with no rows the page took its empty-state branch and never
 * touched the field, so it only surfaced the moment real data landed. accountSummaries()
 * already casts for the same reason.
 *
 * TypeScript will NOT catch a regression here — `LedgerRow.txn_date` is declared string,
 * and a tagged-template query is opaque to the compiler. Keep the cast.
 */
export async function recentTransactions(limit = 100): Promise<LedgerRow[]> {
  return (await sql`
    SELECT t.id, t.display_id, t.txn_date::text AS txn_date, t.normalized_merchant,
           s.name AS store_name, t.raw_description,
           t.amount, t.status, t.source,
           a.name AS account_name, c.name AS category_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN canonical_stores s ON s.id = t.canonical_store_id
    -- Merged duplicates keep their row and their id, but never appear in the ledger.
    WHERE t.merged_into_id IS NULL
    ORDER BY t.txn_date DESC, t.created_at DESC
    LIMIT ${limit}
  `) as LedgerRow[];
}

export interface AccountSummary {
  id: string;
  name: string;
  institution: string;
  type: string;
  txn_count: number;
  /** NOT a balance — see accountSummaries(). Net movement over the covered window. */
  net_change: string | null;
  money_in: string | null;
  money_out: string | null;
  covered_from: string | null;
  reconciled_through: string | null;
}

/**
 * Per-account movement, surfaced with the window it covers.
 *
 * ⚠️ THIS IS NOT A BALANCE, AND THE FIELD USED TO CLAIM IT WAS. A balance needs an opening
 * figure, and `accounts` has no opening_balance column: the CSVs start 2025-01-25 on
 * accounts that already existed, so summing them gives the CHANGE over the export window,
 * not what is in the account. It is named net_change accordingly. Real balances are an open
 * item (docs §9) and need opening_balance + opening_balance_date per account.
 *
 * ⚠️ The sheet era's net change is structurally inflated for checking, and no arithmetic
 * fixes it: the sheet was a BUDGET log, not a bank ledger. Its 'Credit Card Pmts' category
 * has zero rows, so income was recorded while the card payments that consumed it never
 * were. Money goes in and never comes out.
 *
 * ⚠️ NET CHANGE INCLUDES TRANSFERS; SPEND DOES NOT. Easy to get backwards — this query used
 * to filter `NOT excluded_from_totals` for the total, harmless only because nothing was ever
 * excluded. Once transfer detection ran it would have added $106k of card payments and
 * savings transfers back in. Paying the card does move money (count it); it is not spending
 * (don't count it in money_in/money_out).
 *
 * ⚠️ Sums come from counted_transactions, NOT transactions, or the sheet/CSV overlap
 * double-counts and USAA Checking reports +$202,592 off 18 months counted twice.
 * See db/migrations/0008.
 */
export async function accountSummaries(): Promise<AccountSummary[]> {
  return (await sql`
    SELECT a.id, a.name, a.institution, a.type::text AS type,
           COUNT(t.id)::int AS txn_count,
           MIN(t.txn_date)::text AS covered_from,
           COALESCE(SUM(t.amount), 0)::text AS net_change,
           COALESCE(SUM(t.amount) FILTER (
             WHERE t.amount > 0 AND NOT t.excluded_from_totals), 0)::text AS money_in,
           COALESCE(SUM(t.amount) FILTER (
             WHERE t.amount < 0 AND NOT t.excluded_from_totals), 0)::text AS money_out,
           MAX(t.txn_date)::text AS reconciled_through
    FROM accounts a
    LEFT JOIN counted_transactions t ON t.account_id = a.id
    WHERE a.active
    GROUP BY a.id, a.name, a.institution, a.type
    ORDER BY a.name
  `) as AccountSummary[];
}

export interface SpendEra {
  era: "sheet" | "csv";
  from: string;
  to: string;
  txn_count: number;
  spent: string;
  received: string;
}

export interface SpendReport {
  eras: SpendEra[];
  transfer_rows: number;
  /** Transfers with only one leg in the ledger — excluded, but never paired. */
  unpaired_transfers: number;
  /** Sheet rows superseded by CSV coverage. The reconciliation backlog, counted. */
  superseded_sheet_rows: number;
}

/**
 * Spending — SPLIT BY ERA, and the split is the honest part.
 *
 * ⚠️ A SINGLE LEDGER-WIDE TOTAL IS STILL NOT SHOWABLE, even now that transfers are
 * excluded. Summing raw `transactions` reports $564k spent against ~$181k of real spending
 * per era, because the sheet and CSV histories overlap (docs §2e). Transfer detection fixed
 * the transfers problem; it does not fix the duplication problem.
 *
 * The slicing rule lives in the counted_transactions view (db/migrations/0008), which also
 * supplies the `era` label — deliberately in ONE place, because every future SUM needs the
 * same rule and the next one written will otherwise forget it.
 */
export async function spendReport(): Promise<SpendReport> {
  const eras = (await sql`
    SELECT era, MIN(txn_date)::text AS from, MAX(txn_date)::text AS to,
           COUNT(*)::int AS txn_count,
           COALESCE(-SUM(amount) FILTER (
             WHERE amount < 0 AND NOT excluded_from_totals), 0)::text AS spent,
           COALESCE(SUM(amount) FILTER (
             WHERE amount > 0 AND NOT excluded_from_totals), 0)::text AS received
    FROM counted_transactions
    GROUP BY era ORDER BY MIN(txn_date)
  `) as SpendEra[];

  const [counts] = (await sql`
    SELECT
      (SELECT COUNT(*) FROM counted_transactions
        WHERE exclusion_reason = 'transfer')::int AS transfer_rows,
      (SELECT COUNT(*) FROM counted_transactions
        WHERE exclusion_reason = 'transfer' AND transfer_group_id IS NULL)::int
        AS unpaired_transfers,
      -- The reconciliation backlog: sheet rows the CSVs supersede, i.e. exactly the rows
      -- the view leaves out. Counted from the base table on purpose — they are absent from
      -- the view by definition, so it cannot report on them.
      (SELECT COUNT(*) FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.merged_into_id IS NULL AND t.source = 'sheet' AND a.supports_csv
          AND t.txn_date >= (SELECT MIN(txn_date) FROM transactions
                             WHERE source = 'csv' AND merged_into_id IS NULL))::int
        AS superseded_sheet_rows
  `) as { transfer_rows: number; unpaired_transfers: number; superseded_sheet_rows: number }[];

  return { eras, ...counts };
}
