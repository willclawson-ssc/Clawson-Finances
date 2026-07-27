/**
 * Transfer detection — the two-leg pairing half.
 *
 * A transfer is one movement of money recorded twice: pay the credit card and the outflow
 * lands in checking while the inflow lands on the card. Summing both counts the payment as
 * spending on top of the purchases it settled, which is why the USAA card "nets" +$1,598
 * over 18 months and why no figure in this app has yet been allowed to say "spent".
 *
 * ⚠️ THIS FILE ONLY HANDLES THE MINORITY CASE. Measured on the real ledger: 156 of 763
 * transfer legs have a counterparty leg here to pair with; the other 607 send money to
 * Marcus, Goldman Sachs, Fidelity, GuideStone, Venmo or Bonvenu — accounts that are not in
 * this ledger and, for Bonvenu, never can be (no CSV export exists). Excluding a transfer
 * from spending must therefore NOT depend on finding its partner. That decision is made
 * from canonical_stores.kind = 'transfer' alone, in scripts/detect-transfers.mts. Pairing
 * is the enrichment on top: it makes the movement one object instead of two.
 *
 * The gate is both-sides-transfer-kind, and that is measured rather than assumed: of the
 * 164 candidate counterparty legs found for CSV transfer rows, 164 resolved to a
 * kind='transfer' vendor. Requiring it costs nothing and stops the matcher from ever
 * pairing a coincidental $40 purchase against a $40 payment.
 */

/** A candidate leg. Amount is LEDGER-NORMALIZED: negative out, positive in. */
export interface TransferLeg {
  id: string;
  accountId: string;
  /** YYYY-MM-DD */
  txnDate: string;
  amount: number;
}

export interface TransferPair {
  /** The negative leg — money leaving. */
  outflowId: string;
  /** The positive leg — money arriving. */
  inflowId: string;
  /** Positive magnitude of the movement. */
  amount: number;
  /** Earlier of the two leg dates. */
  occurredOn: string;
  /** 0-3 in practice; the card side often posts before the bank side. */
  lagDays: number;
}

/**
 * A leg the matcher refused to pair. Left for a human rather than guessed: linking the
 * wrong two legs hides a real movement AND invents a false one.
 */
export interface AmbiguousLeg {
  legId: string;
  candidateIds: string[];
}

export interface PairingResult {
  pairs: TransferPair[];
  ambiguous: AmbiguousLeg[];
  /** Transfer legs whose counterparty is outside this ledger. Excluded, never paired. */
  unpairedIds: string[];
}

/**
 * Measured lag between the two legs is 0-3 days (Discover 07/10 <-> USAA 07/13), so an
 * exact-date match would miss most pairs. Kept at 3 rather than widened: every extra day
 * multiplies the chance that two unrelated same-amount movements collide.
 */
const MAX_LAG_DAYS = 3;

/** Amounts arrive from Postgres numeric(14,2); compare at half-cent tolerance. */
const CENT = 0.005;

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000);

/**
 * Pair up transfer legs.
 *
 * ⚠️ Pairs only where the choice is MUTUAL and UNIQUE — A's sole candidate is B and B's
 * sole candidate is A. The obvious greedy alternative (walk the legs, take the first
 * available match) is order-dependent: two identical $600 savings transfers a day apart
 * would pair differently depending on which row the query returned first, and one ordering
 * silently leaves a leg stranded. Mutual uniqueness gives the same answer for any input
 * order, and everything it can't decide becomes an explicit ambiguous row.
 *
 * Callers must pass only legs whose vendor is kind='transfer', already excluding merged
 * rows.
 */
export function pairTransfers(legs: TransferLeg[]): PairingResult {
  // Zero-amount rows would match every other zero-amount row; they are also never a real
  // movement worth linking.
  const usable = legs.filter((l) => Math.abs(l.amount) > CENT);

  const candidates = new Map<string, string[]>();
  for (const leg of usable) {
    candidates.set(
      leg.id,
      usable
        .filter(
          (other) =>
            other.id !== leg.id &&
            // Two legs of one movement are in DIFFERENT accounts. Same-account opposite
            // amounts are a refund or the sheet/CSV duplication, not a transfer.
            other.accountId !== leg.accountId &&
            Math.abs(other.amount + leg.amount) < CENT &&
            Math.abs(dayDiff(other.txnDate, leg.txnDate)) <= MAX_LAG_DAYS,
        )
        .map((other) => other.id),
    );
  }

  const byId = new Map(usable.map((l) => [l.id, l]));
  const pairs: TransferPair[] = [];
  const ambiguous: AmbiguousLeg[] = [];
  const unpairedIds: string[] = [];
  const seenPair = new Set<string>();

  for (const leg of usable) {
    const mine = candidates.get(leg.id)!;

    if (mine.length === 0) {
      unpairedIds.push(leg.id);
      continue;
    }

    const theirs = mine.length === 1 ? candidates.get(mine[0])! : null;
    if (!theirs || theirs.length !== 1 || theirs[0] !== leg.id) {
      ambiguous.push({ legId: leg.id, candidateIds: mine });
      continue;
    }

    const partner = byId.get(mine[0])!;
    // Each mutual pair is reached twice, once from each end.
    const key = [leg.id, partner.id].sort().join("|");
    if (seenPair.has(key)) continue;
    seenPair.add(key);

    const [out, into] = leg.amount < 0 ? [leg, partner] : [partner, leg];
    pairs.push({
      outflowId: out.id,
      inflowId: into.id,
      amount: Math.abs(leg.amount),
      occurredOn: leg.txnDate < partner.txnDate ? leg.txnDate : partner.txnDate,
      lagDays: Math.abs(dayDiff(leg.txnDate, partner.txnDate)),
    });
  }

  return { pairs, ambiguous, unpairedIds };
}
