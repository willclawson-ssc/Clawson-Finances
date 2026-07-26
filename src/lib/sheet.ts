/**
 * Adapter for the "Clawson Finances" Google Sheet — the Form-responses tab that has been
 * the live ledger since 2023-03-01 (5,886 rows).
 *
 * It is NOT a bank export and must not be treated like one. Three differences drive
 * everything below:
 *
 *  1. Amounts are MAGNITUDES. Direction lives in a separate "Income or Expense?" column,
 *     so sign comes from that — never from accounts.type the way a CSV's does (§3).
 *  2. Every field was hand-typed, so every field is dirty: 62 distinct category strings
 *     for a 24-category taxonomy, 14 payment-method spellings for 7 accounts, a handful
 *     of impossible dates.
 *  3. It names the payment method per row, so one file spans every account at once —
 *     including accounts no CSV export exists for.
 */
import { normalizeMerchant, parseAmount, parseDate } from "./normalize";

export interface SheetRow {
  /** 1-based row number in the tab; the stable natural key for idempotent re-import. */
  sheetRow: number;
  accountKey: AccountKey;
  txnDate: string;
  /** Ledger-normalized: negative = money out. */
  amount: number;
  rawDescription: string;
  normalizedMerchant: string;
  notes: string | null;
  /** The category string exactly as typed, kept for audit. */
  sourceCategory: string | null;
  /** Canonical taxonomy name, or null when it could not be resolved. */
  category: string | null;
  flags: string[];
}

export interface SheetParseResult {
  rows: SheetRow[];
  /** Rows with nothing usable in them — blank spacer rows and the like. */
  skipped: { sheetRow: number; reason: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts. The Form's dropdown accumulated spellings over three years, and
// "Checking Account" / "USAA Checking" overlap in time (Apr–Oct 2025 vs May 2025–now)
// so it is NOT a clean rename — Will confirmed 2026-07-26 that both mean the same USAA
// checking account.
// ─────────────────────────────────────────────────────────────────────────────
export type AccountKey =
  | "usaa_visa" | "usaa_checking" | "discover" | "apple_card" | "fgb_visa" | "cash" | "dads_checking";

export const ACCOUNTS: Record<AccountKey, {
  name: string; institution: string; type: "asset" | "liability"; supportsCsv: boolean; active: boolean;
}> = {
  usaa_visa:     { name: "USAA Credit Card", institution: "USAA",     type: "liability", supportsCsv: true,  active: true },
  usaa_checking: { name: "USAA Checking",    institution: "USAA",     type: "asset",     supportsCsv: true,  active: true },
  discover:      { name: "Discover",         institution: "Discover", type: "liability", supportsCsv: true,  active: true },
  apple_card:    { name: "Apple Card",       institution: "Apple",    type: "liability", supportsCsv: true,  active: true },
  // Closed: the sheet's last FGB row is 2023-09-15. Kept so history has somewhere to land.
  fgb_visa:      { name: "FGB Visa",         institution: "FGB",      type: "liability", supportsCsv: false, active: false },
  cash:          { name: "Cash",             institution: "Cash",     type: "asset",     supportsCsv: false, active: true },
  // One row, 2025-09-15. Real, and it would otherwise be silently dropped.
  dads_checking: { name: "Dad's Checking",   institution: "Other",    type: "asset",     supportsCsv: false, active: false },
};

const METHOD_MAP: Record<string, AccountKey> = {
  "usaa visa": "usaa_visa",
  "usaa checking": "usaa_checking",
  "checking account": "usaa_checking",
  discover: "discover",
  "apple card": "apple_card",
  "fgb visa": "fgb_visa",
  cash: "cash",
  "dads checking": "dads_checking",
};

/** Collapse whitespace/case/apostrophes so "USAA  Checking" and "usaa checking" converge. */
function methodKey(v: string): string {
  return v.toLowerCase().replace(/['’]/g, "").replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Categories. The taxonomy is the sheet's own Labels!Form Cats (already seeded into
// `categories`). Case folding resolves all but eight strings; those eight are listed
// explicitly rather than fuzzy-matched, so a future new typo fails loudly into the
// review queue instead of being silently guessed at.
// ─────────────────────────────────────────────────────────────────────────────
export const TAXONOMY = [
  "Baby Stuff", "Business Expenses", "Credit Card Pmts", "Food (Groceries)",
  "Food (Restaurants)", "Gifts & Offerings", "Housing", "Medical Expenses", "Pets",
  "Phone", "Savings", "Tithe", "Transportation", "Utilities", "Personal Spending",
  "MISC", "Travel", "Entertainment", "Home Improvement", "Christmas", "Future Item 3",
  "W2 Income", "1099 Income", "MISC Income",
] as const;

const BY_LOWER = new Map(TAXONOMY.map((c) => [c.toLowerCase(), c as string]));

/** Unambiguous misspellings, mapped by hand. Anything not here and not case-foldable
 *  is left uncategorized for review — 'inspection', 'home' and 'business income' are
 *  guesses, and a wrong category is worse than a blank one. */
const CATEGORY_TYPOS: Record<string, string> = {
  utlities: "Utilities",
  "food (restauants)": "Food (Restaurants)",
  "gits & offerings": "Gifts & Offerings",
  "pesonal spending": "Personal Spending",
  "misc inome": "MISC Income",
};

export function canonicalCategory(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  return BY_LOWER.get(s) ?? CATEGORY_TYPOS[s] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Date column is hand-typed and occasionally impossible: two-digit years ("2/25/26"),
 * and year typos that land in antiquity ("3/1/0024", 2022 in a sheet that starts 2023).
 * The adjacent Timestamp column is written by the Form itself and is always right, so it
 * is the repair signal — the entry was submitted within a day or two of the purchase.
 */
export function repairDate(dateCell: string, timestampCell: string): { date: string | null; flag?: string } {
  const stamp = parseDate((timestampCell || "").split(" ")[0]);
  const direct = parseDate(dateCell);

  if (direct) {
    const year = Number(direct.slice(0, 4));
    // Impossible years, typed straight into the Form: "3/1/0024", "12/18/0024".
    if (year < 2020 || year > 2100) {
      return stamp ? { date: stamp, flag: "date_year_repaired" } : { date: null };
    }
    // Plausible-looking but wrong: same month and day as the submission, one or more
    // years behind it. Two rows do this ("8/10/2022" submitted 8/10/2023, "1/3/2023"
    // submitted 1/3/2024) — the New Year's-Eve-cheque typo, and the only rows in the
    // sheet more than 60 days off their timestamp apart from the impossible ones. A
    // blanket "far from timestamp" rule would risk mangling genuine back-entry; keying
    // on the identical month/day makes the diagnosis certain.
    if (stamp && direct.slice(5) === stamp.slice(5) && direct.slice(0, 4) !== stamp.slice(0, 4)) {
      return { date: stamp, flag: "date_year_repaired" };
    }
    return { date: direct };
  }

  // MM/DD/YY — handled here rather than in parseDate() so the CSV adapters, where a
  // two-digit year would be ambiguous with other formats, keep rejecting it.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec((dateCell || "").trim());
  if (m) {
    const yy = Number(m[3]);
    return { date: `20${String(yy).padStart(2, "0")}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` };
  }

  return stamp ? { date: stamp, flag: "date_from_timestamp" } : { date: null };
}

/**
 * Sign. Direction comes from the Income/Expense column, applied to the magnitude — but
 * 15 rows carry a NEGATIVE amount, which is how Will recorded refunds ("Amazon / return
 * / -31.28 / Expense"). A negative therefore FLIPS the column's direction rather than
 * being ignored. Four of the fifteen are returns filed as "Income", where the flip gives
 * the wrong answer; they are flagged for review rather than special-cased, since a rule
 * inferred from four rows would be a guess.
 */
export function ledgerAmount(raw: number, kind: string): { amount: number; flag?: string } {
  const income = kind.trim().toLowerCase().startsWith("income");
  const amount = income ? raw : -raw;
  return raw < 0 ? { amount, flag: "negative_amount" } : { amount };
}

export function parseSheetRows(records: Record<string, string>[]): SheetParseResult {
  const rows: SheetRow[] = [];
  const skipped: { sheetRow: number; reason: string }[] = [];

  records.forEach((rec, i) => {
    const sheetRow = i + 2; // 1-based, plus the header row
    const get = (k: string) => (rec[k] ?? "").toString().trim();

    const payee = get("Payee/Remitter");
    const rawAmount = parseAmount(get("Amount"));
    const flags: string[] = [];

    // A row with neither a payee nor an amount is a spacer, not data (34 of these).
    if (!payee && rawAmount === null) {
      skipped.push({ sheetRow, reason: "blank row" });
      return;
    }
    if (rawAmount === null) {
      // Four rows where the Amount cell holds text ("icloud storage") — a mis-keyed
      // Form entry. There is no amount to recover, so they cannot become ledger rows.
      skipped.push({ sheetRow, reason: `unparseable amount ${JSON.stringify(get("Amount"))}` });
      return;
    }

    const { date, flag: dateFlag } = repairDate(get("Date"), get("Timestamp"));
    if (!date) {
      skipped.push({ sheetRow, reason: `unparseable date ${JSON.stringify(get("Date"))}` });
      return;
    }
    if (dateFlag) flags.push(dateFlag);

    const method = methodKey(get("Method of Payment"));
    const accountKey = METHOD_MAP[method];
    if (!accountKey) {
      skipped.push({ sheetRow, reason: `unknown payment method ${JSON.stringify(get("Method of Payment"))}` });
      return;
    }

    const { amount, flag: amountFlag } = ledgerAmount(rawAmount, get("Income or Expense?"));
    if (amountFlag) flags.push(amountFlag);

    const sourceCategory = get("Category") || null;
    const category = sourceCategory ? canonicalCategory(sourceCategory) : null;
    if (sourceCategory && !category) flags.push("unmapped_category");
    if (!sourceCategory) flags.push("no_category");

    const notes = get("Description ") || get("Description") || null;

    rows.push({
      sheetRow,
      accountKey,
      txnDate: date,
      amount,
      // The payee IS the descriptor here; there is no bank string behind it.
      rawDescription: payee || notes || "(no payee)",
      normalizedMerchant: normalizeMerchant(payee || notes || ""),
      notes,
      sourceCategory,
      category,
      flags,
    });
  });

  return { rows, skipped };
}
