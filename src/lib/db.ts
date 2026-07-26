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

export interface LedgerRow {
  id: string;
  txn_date: string;
  normalized_merchant: string;
  raw_description: string;
  amount: string;
  status: string;
  source: string;
  account_name: string;
  category_name: string | null;
}

export async function recentTransactions(limit = 100): Promise<LedgerRow[]> {
  return (await sql`
    SELECT t.id, t.txn_date, t.normalized_merchant, t.raw_description,
           t.amount, t.status, t.source,
           a.name AS account_name, c.name AS category_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
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
  balance: string | null;
  reconciled_through: string | null;
}

/**
 * Running balance is COMPUTED, never stored, and surfaced with the date it is complete
 * through. The ledger is complete as of the last import — staleness is uniform and
 * legible rather than partial in a hard-to-explain way.
 */
export async function accountSummaries(): Promise<AccountSummary[]> {
  return (await sql`
    SELECT a.id, a.name, a.institution, a.type::text AS type,
           COUNT(t.id)::int AS txn_count,
           COALESCE(SUM(t.amount), 0)::text AS balance,
           MAX(t.txn_date)::text AS reconciled_through
    FROM accounts a
    LEFT JOIN transactions t
      ON t.account_id = a.id AND NOT t.excluded_from_totals
    WHERE a.active
    GROUP BY a.id, a.name, a.institution, a.type
    ORDER BY a.name
  `) as AccountSummary[];
}
