/**
 * Per-institution CSV adapters. Column layouts were derived from Will's REAL exports
 * (see ~/docs/finances-app.md §3), not from documentation.
 *
 *   USAA      Date, Description, Original Description, Category, Amount, Status
 *   Discover  Trans. Date, Post Date, Description, Amount, Category
 *   AppleCard Transaction Date, Clearing Date, Description, Merchant, Category, Type,
 *             Amount (USD), Purchased By
 *
 * Bonvenu has NO export — that account is manual-entry only and has no adapter.
 */
import { normalizeMerchant, normalizeAmount, parseAmount, parseDate } from "./normalize";

export type AccountType = "asset" | "liability";
export type AdapterId = "usaa" | "discover" | "applecard";

export interface ParsedRow {
  txnDate: string;
  postDate: string | null;
  rawDescription: string;
  normalizedMerchant: string;
  amount: number; // ledger-normalized: negative = money out
  status: "posted" | "pending" | "scheduled";
  bankCategory: string | null;
  purchasedBy: string | null;
  /** Institution's own type label, verbatim. Apple Card only; see migration 0003. */
  txnType: string | null;
  occurrenceN: number;
}

export interface ParseResult {
  rows: ParsedRow[];
  skipped: { line: number; reason: string }[];
}

const pick = (r: Record<string, string>, ...keys: string[]): string => {
  for (const k of keys) {
    const hit = Object.keys(r).find((c) => c.trim().toLowerCase() === k.toLowerCase());
    if (hit && r[hit] != null && String(r[hit]).trim() !== "") return String(r[hit]).trim();
  }
  return "";
};

/** USAA is the only institution that reports status; the others are posted-only. */
function usaaStatus(v: string): ParsedRow["status"] {
  const s = v.toLowerCase();
  if (s.includes("pending")) return "pending";
  if (s.includes("recurring") || s.includes("scheduled")) return "scheduled";
  return "posted";
}

export function detectAdapter(headers: string[]): AdapterId | null {
  const h = headers.map((x) => x.trim().toLowerCase());
  const has = (n: string) => h.includes(n.toLowerCase());
  if (has("Original Description") && has("Status")) return "usaa";
  if (has("Trans. Date") && has("Post Date")) return "discover";
  if (has("Purchased By") || has("Clearing Date")) return "applecard";
  return null;
}

export function parseRows(
  records: Record<string, string>[],
  adapter: AdapterId,
  accountType: AccountType,
): ParseResult {
  const rows: ParsedRow[] = [];
  const skipped: { line: number; reason: string }[] = [];

  // Occurrence ordinal within this file. REQUIRED for dedup: usaa-sample-B contains 19
  // distinct (date, description, amount) keys that legitimately repeat — ANTHROPIC
  // $44.00 twice on 2026-06-14, etc. Without the ordinal a re-import would silently
  // drop the second copy of a real charge.
  const seen = new Map<string, number>();

  records.forEach((rec, i) => {
    const line = i + 2; // 1-based + header row

    const dateStr =
      adapter === "usaa"
        ? pick(rec, "Date")
        : adapter === "discover"
          ? pick(rec, "Trans. Date")
          : pick(rec, "Transaction Date");
    const txnDate = parseDate(dateStr);
    if (!txnDate) {
      skipped.push({ line, reason: `unparseable date ${JSON.stringify(dateStr)}` });
      return;
    }

    const postDate =
      adapter === "discover"
        ? parseDate(pick(rec, "Post Date"))
        : adapter === "applecard"
          ? parseDate(pick(rec, "Clearing Date"))
          : null;

    const rawAmount = parseAmount(
      adapter === "applecard" ? pick(rec, "Amount (USD)", "Amount") : pick(rec, "Amount"),
    );
    if (rawAmount === null) {
      skipped.push({ line, reason: "unparseable amount" });
      return;
    }

    // Apple gives a clean `Merchant` field ("Aldi 75107") alongside a raw `Description`
    // carrying the full address — the best-quality source of the three.
    // USAA's `Original Description` is richer but is SOMETIMES EMPTY, so never key on
    // it alone; fall back to the bank-cleaned `Description`.
    const rawDescription =
      adapter === "applecard"
        ? pick(rec, "Description", "Merchant")
        : adapter === "usaa"
          ? pick(rec, "Original Description", "Description")
          : pick(rec, "Description");

    if (!rawDescription) {
      skipped.push({ line, reason: "empty description" });
      return;
    }

    const merchantSource =
      adapter === "applecard" ? pick(rec, "Merchant", "Description") : rawDescription;

    const key = `${txnDate}|${rawDescription}|${rawAmount}`;
    const occurrenceN = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrenceN);

    rows.push({
      txnDate,
      postDate,
      rawDescription,
      normalizedMerchant: normalizeMerchant(merchantSource),
      amount: normalizeAmount(rawAmount, accountType),
      status: adapter === "usaa" ? usaaStatus(pick(rec, "Status")) : "posted",
      bankCategory: pick(rec, "Category") || null,
      purchasedBy: adapter === "applecard" ? pick(rec, "Purchased By") || null : null,
      // Apple is the only one of the four that states the type outright
      // (Purchase/Payment/Credit/Debit) — the one non-heuristic transfer signal available.
      txnType: adapter === "applecard" ? pick(rec, "Type") || null : null,
      occurrenceN,
    });
  });

  return { rows, skipped };
}

/**
 * Sanity-check the file against the account it is being imported into.
 *
 * Both USAA exports are named bk_download.csv, share an identical header, and contain
 * nothing that identifies the account — only the SIGN PATTERN differs (checking: mostly
 * negative, card: mostly positive). Picking the wrong account therefore inverts every
 * amount in the file and fails silently, which is the single most damaging mistake
 * available in this UI (docs §9).
 *
 * This is a warning, never a block: it reads the ledger-normalized amounts, so a genuine
 * statement dominated by refunds or a payoff month could legitimately trip it. Measured
 * against the four real exports, the correct pairing is never flagged — checking is 78%
 * outflow, the card 92%, Discover 80%, Apple 91%.
 */
export function accountTypeWarning(rows: ParsedRow[], accountName: string): string | null {
  if (rows.length < 20) return null; // too small to say anything
  const out = rows.filter((r) => r.amount < 0).length;
  const share = out / rows.length;
  // After normalization a correctly-paired file is mostly money OUT, whatever the
  // institution's own convention was. Mostly money IN means the sign got flipped.
  if (share >= 0.3) return null;
  return (
    `${Math.round((1 - share) * 100)}% of rows in this file are money IN after applying ` +
    `"${accountName}"'s account type. That usually means the file belongs to the other ` +
    `kind of account (e.g. a credit-card export imported into a checking account), which ` +
    `inverts every amount. Check the account before trusting this import.`
  );
}
