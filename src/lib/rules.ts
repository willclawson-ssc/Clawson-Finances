/**
 * Matching semantics for the `rules` table.
 *
 * ⚠️ PREFIX IS THE DEFAULT FOR SEEDED RULES, AND THE REASON IS MEASURED, NOT AESTHETIC.
 * Sheet vendor names are hand-typed ("Aldi", "Raceway"); bank descriptors carry store
 * numbers and city/state tails that survive normalization ("ALDI BOSSIER CITY",
 * "RACEWAY6935"). Against the 3,122 real CSV rows now in the ledger:
 *
 *     exact match                       1,003  (32.1%)
 *     token-boundary prefix (this file) 2,713  (86.9%)
 *
 * Exact-matching sheet-derived rules would therefore have quietly failed — the docs
 * flagged the risk (§2e); these numbers are it.
 *
 * "Token-boundary" matters: a bare `LIKE pattern || '%'` lets "SONIC" claim
 * "SONICARE" and "PET" claim "PETROLEUM". The pattern must be followed by a space or
 * the end of the string, i.e. it must consume whole words.
 */
export type MatchType = "exact" | "prefix" | "contains";

export interface Rule {
  id: string;
  pattern: string;
  match_type: MatchType;
  keyword: string | null;
  category_id: string;
  priority: number;
}

export function ruleMatches(rule: Rule, merchant: string, haystack = ""): boolean {
  const m = merchant.toUpperCase();
  const p = rule.pattern.toUpperCase();

  const hit =
    rule.match_type === "exact"
      ? m === p
      : rule.match_type === "prefix"
        ? m === p || m.startsWith(p + " ")
        : m === p || m.includes(p);
  if (!hit) return false;

  // Optional qualifier for genuinely multi-category vendors — "SAM S CLUB" + "gas"
  // -> Transportation, else Groceries. Will confirmed 2026-07-26 that a Home Depot or
  // Amazon purchase legitimately lands in more than one budget category, so vendor
  // alone can never resolve those; the qualifier (or the LLM) has to.
  if (!rule.keyword) return true;
  return `${merchant} ${haystack}`.toUpperCase().includes(rule.keyword.toUpperCase());
}

/** Most specific wins: longer patterns first, then explicit priority. Exact beats prefix. */
export function pickRule(rules: Rule[], merchant: string, haystack = ""): Rule | null {
  const hits = rules.filter((r) => ruleMatches(r, merchant, haystack));
  if (!hits.length) return null;
  return hits.sort((a, b) =>
    (b.keyword ? 1 : 0) - (a.keyword ? 1 : 0) ||
    (a.match_type === "exact" ? -1 : 0) - (b.match_type === "exact" ? -1 : 0) ||
    b.pattern.length - a.pattern.length ||
    a.priority - b.priority,
  )[0];
}
