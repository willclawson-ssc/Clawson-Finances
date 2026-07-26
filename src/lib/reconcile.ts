/**
 * Pending → posted reconciliation.
 *
 * ⚠️ THE failure mode for CSV-majority operation, and it is not hypothetical: the ledger
 * currently holds three USAA rows pending as of 2026-07-24, one of them
 * "OLIVE GARDEN 0021813 -34.00". When that settles, the tip lands and the bank re-exports
 * it as Posted at a different amount — and often a different description. The dedup
 * fingerprint covers (account, date, raw_description, amount, occurrence_n), so a changed
 * amount is a changed fingerprint, and the next import inserts the meal a SECOND time
 * while the stale pending row lives on forever.
 *
 * Idempotent re-import (which is verified and works) cannot help here: the two rows are
 * genuinely different rows. This is the one place §3 says fuzzy matching is unavoidable.
 *
 * Sign note: amounts are already ledger-normalized when this runs, so both legs are
 * negative on a purchase and "the amount grew" means it got MORE negative.
 */
import type { ParsedRow } from "./adapters";

export interface ExistingPending {
  id: string;
  txn_date: string;
  raw_description: string;
  normalized_merchant: string;
  amount: string | number;
  status: string;
}

export interface Settlement {
  pendingId: string;
  row: ParsedRow;
}

export interface MatchResult {
  /** Incoming rows that settle an existing pending row — update, do NOT insert. */
  settlements: Settlement[];
  /** Incoming rows with no pending counterpart — insert normally. */
  fresh: ParsedRow[];
}

/** Days a pending charge may take to settle. USAA's observed lag is 1–3; 5 is slack. */
const MAX_SETTLE_DAYS = 5;
/**
 * How much the amount may move between pending and posted. Restaurant tips are the
 * reason this is not zero — a 20% tip on a pre-tip authorization is routine, and
 * 25% (plus a dollar of slack for small tickets) covers it without being so loose that
 * two unrelated charges at the same merchant collapse into one.
 */
const AMOUNT_TOLERANCE = 0.25;
const AMOUNT_FLOOR = 1.0;

const days = (a: string, b: string) =>
  Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000);

/** Shared leading words — cheap stand-in for trigram similarity on the app side. */
function merchantAffinity(a: string, b: string): number {
  if (a === b) return 1;
  const x = a.split(" ").filter(Boolean);
  const y = b.split(" ").filter(Boolean);
  if (!x.length || !y.length) return 0;
  if (x[0] !== y[0]) return 0; // first token must agree: OLIVE vs PAYPAL is never a match
  let shared = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) shared++;
    else break;
  }
  return shared / Math.max(x.length, y.length);
}

export function matchSettlements(incoming: ParsedRow[], pending: ExistingPending[]): MatchResult {
  const settlements: Settlement[] = [];
  const fresh: ParsedRow[] = [];
  // A pending row settles at most once, or one authorization could absorb several real
  // charges at the same merchant.
  const consumed = new Set<string>();

  for (const row of incoming) {
    // Only a POSTED row can settle something. A still-pending row re-exported unchanged
    // is caught by the ordinary fingerprint dedup.
    if (row.status !== "posted") {
      fresh.push(row);
      continue;
    }

    let bestId: string | null = null;
    let bestScore = -1;

    for (const p of pending) {
      if (consumed.has(p.id)) continue;

      // Settlement never happens BEFORE the authorization.
      const lag = days(row.txnDate, p.txn_date);
      if (lag < 0 || lag > MAX_SETTLE_DAYS) continue;

      const pAmt = Number(p.amount);
      const drift = Math.abs(row.amount - pAmt);
      if (drift > Math.max(AMOUNT_FLOOR, Math.abs(pAmt) * AMOUNT_TOLERANCE)) continue;

      const affinity = merchantAffinity(row.normalizedMerchant, p.normalized_merchant);
      if (affinity < 0.5) continue;

      // Prefer the closest amount, then the closest date, then the best name match.
      const score = affinity * 100 - drift * 10 - lag;
      if (score > bestScore) {
        bestScore = score;
        bestId = p.id;
      }
    }

    if (bestId) {
      consumed.add(bestId);
      settlements.push({ pendingId: bestId, row });
    } else {
      fresh.push(row);
    }
  }

  return { settlements, fresh };
}
