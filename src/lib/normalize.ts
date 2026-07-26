/**
 * Merchant normalization — a MANDATORY prerequisite for the rules layer, not polish.
 *
 * Real bank descriptors embed a unique token per purchase, e.g.
 *   AMAZON MKTPL*V98087A63 AMZN.COM/BILLWA18O7YA8SW4E
 * Measured on Will's exports: Discover had 13 Amazon rows / 13 distinct strings (100%
 * unique), USAA-card 127 rows / 120 distinct. Matching rules on raw descriptors would
 * therefore treat almost every e-commerce purchase as a brand-new vendor, collapsing the
 * deterministic layer and dumping everything on the LLM.
 *
 * After normalization those 120 distinct USAA strings collapse to 3.
 *
 * ⚠️ Two different strings, never conflate them:
 *   - raw descriptor      -> dedup fingerprint (exactness matters)
 *   - normalized merchant -> rules + LLM        (generalization matters)
 */

const PAYMENT_SUFFIX = /\b(APPLE PAY|GOOGLE PAY|SAMSUNG PAY)\b.*$/;
const CARD_TAIL = /\bENDING IN\s*\d+\b.*$/;
/**
 * Domain-shaped tokens: keep the LABEL, drop the TLD and any path.
 * "AMAZON.COM/BILLWA" -> "AMAZON". Deleting the whole token instead would erase the
 * merchant name for rows whose descriptor is nothing but a domain, forcing them down
 * the raw-string fallback and re-fragmenting the vendor.
 */
const URL_TAIL = /\b([A-Z0-9-]+)\.(?:COM|NET|ORG|CO|IO|BIZ)(?:\/\S*)?/g;
/**
 * NOTE: there is deliberately NO "delete the *TOKEN" rule.
 * The `*` separator means opposite things depending on the vendor:
 *   AMAZON MKTPL*V98087A63   -> the starred part is a random order ID (drop it)
 *   PAYPAL *PARAMNTPLUS      -> the starred part IS the merchant  (keep it)
 * Deleting both stripped the real merchant from every PayPal/Square row and left them
 * normalized to a bare state code. Instead the `*` is treated as punctuation (split
 * into a separate token) and isOrderIdToken decides which side to discard.
 */
const LONG_DIGITS = /\b\d{3,}\b/g;
/**
 * Is this token a random order ID rather than part of a vendor name?
 *
 * Both look alphanumeric, so length/character-class tests alone can't separate them —
 * a naive rule stripped "RACEWAY680" and left 102 transactions normalized to the bare
 * city name. The distinguishing signal is ALTERNATION: a store number is one letter run
 * followed by one digit run ("RACEWAY680" -> 2 groups), while a generated ID flips back
 * and forth ("BV09G6WG0" -> B,V/09/G/6/WG/0 -> 6 groups).
 */
function isOrderIdToken(tok: string): boolean {
  if (tok.length < 6) return false;
  if (!/[A-Z]/.test(tok) || !/\d/.test(tok)) return false;
  const groups = tok.match(/[A-Z]+|\d+/g);
  return (groups?.length ?? 0) >= 4;
}
const STATE_TAIL = /\s+(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s*$/;
const PHONE = /\b\d{3}-\d{3}-\d{4}\b/g;
const TRANSACTION_NOISE = /\b(POS|PURCHASE|DEBIT|CREDIT|RECURRING|PAYMENT THANK YOU|SQ|TST|PAYPAL)\b\s*\*?/g;

export function normalizeMerchant(raw: string): string {
  let s = (raw || "").toUpperCase();

  s = s.replace(PAYMENT_SUFFIX, " ");
  s = s.replace(CARD_TAIL, " ");
  s = s.replace(URL_TAIL, "$1 ");
  s = s.replace(PHONE, " ");
  s = s.replace(TRANSACTION_NOISE, " ");
  s = s.replace(LONG_DIGITS, " ");
  // Strip punctuation but keep spaces; apostrophes vanish so
  // "SAM'S CLUB" and "SAMS CLUB" converge.
  s = s.replace(/[^A-Z0-9 ]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(STATE_TAIL, "");

  const kept = s.split(" ").filter((t) => t && !isOrderIdToken(t));
  const out = kept.join(" ").replace(/\s+/g, " ").trim();

  // Never return an empty merchant: an unmatchable-but-present string is far better
  // than a blank one, which would collapse unrelated vendors into a single bucket.
  if (out) return out;
  return (raw || "").toUpperCase().replace(/\s+/g, " ").trim() || "UNKNOWN";
}

/**
 * Sign normalization. THE trap in this dataset: USAA exports checking and credit card
 * in an IDENTICAL format with OPPOSITE semantics, so sign cannot be inferred from the
 * file — only from how the account was declared.
 *
 *   asset     (checking): purchases already negative, income positive -> keep as-is
 *   liability (card):     purchases positive, payments negative       -> flip
 *
 * Output convention everywhere downstream: NEGATIVE = money out, POSITIVE = money in.
 */
export function normalizeAmount(raw: number, accountType: "asset" | "liability"): number {
  return accountType === "liability" ? -raw : raw;
}

/** Parse "$1,234.56", "(12.34)" and "-12.34" into a number. */
export function parseAmount(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[$,\s]/g, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/**
 * Dates arrive in two shapes: USAA uses YYYY-MM-DD, Apple and Discover use MM/DD/YYYY.
 * Returns an ISO date string (YYYY-MM-DD) or null. Deliberately avoids `new Date(str)`,
 * which interprets bare YYYY-MM-DD as UTC and can shift the day backwards in a
 * negative-offset timezone like America/Chicago.
 */
export function parseDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const mo = m[1].padStart(2, "0");
    const d = m[2].padStart(2, "0");
    return `${m[3]}-${mo}-${d}`;
  }
  return null;
}
