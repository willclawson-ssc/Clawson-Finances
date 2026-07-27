/**
 * Resolve a merchant descriptor to a canonical vendor.
 *
 * The rule is LONGEST MATCH WINS, and that single property is what makes the table
 * approach better than stripping noise with regexes: "MOTEL 8 BOSSIER CITY" resolves to
 * Motel 8 rather than Motel, because the longer alias beats the shorter one. No rule has
 * to know in advance which trailing numbers belong to the brand and which are store
 * numbers — the canonical name settles it.
 *
 * Matching is TOKEN-BOUNDARY: an alias must be the whole descriptor or be followed by a
 * space. Without that, "SHELL" claims "SHELLY EUROPE" — a real pair in this data (the
 * fuel brand vs the smart-home hardware vendor), and exactly the sort of silent
 * mis-attribution that a plain LIKE 'pattern%' invites.
 */

export interface StoreAlias {
  pattern: string;
  storeId: string;
}

/**
 * Index aliases by first token. A descriptor can only match an alias that shares its
 * first word, which turns resolution from a scan of ~1,700 patterns into a handful of
 * comparisons — worth doing because import resolves thousands of rows in one request.
 */
export function buildStoreIndex(aliases: StoreAlias[]): Map<string, StoreAlias[]> {
  const idx = new Map<string, StoreAlias[]>();
  for (const a of aliases) {
    const head = a.pattern.split(" ")[0];
    const bucket = idx.get(head);
    if (bucket) bucket.push(a);
    else idx.set(head, [a]);
  }
  // Longest first, so the first hit is the best hit.
  for (const bucket of idx.values()) bucket.sort((x, y) => y.pattern.length - x.pattern.length);
  return idx;
}

export function resolveStore(
  normalizedMerchant: string,
  idx: Map<string, StoreAlias[]>,
): string | null {
  const m = (normalizedMerchant || "").toUpperCase().trim();
  if (!m) return null;
  const bucket = idx.get(m.split(" ")[0]);
  if (!bucket) return null;
  for (const a of bucket) {
    if (m === a.pattern || m.startsWith(a.pattern + " ")) return a.storeId;
  }
  return null;
}
