/**
 * Seed the deterministic `rules` layer from the sheet's human category choices.
 *
 * Every one of the 5,848 imported sheet rows is a vendor→category pair that Will picked
 * by hand, which is exactly the training data the rules layer wants — and it is free of
 * the cost the LLM stage would otherwise pay for the same answer.
 *
 * Two guardrails:
 *   1. Patterns are the NORMALIZED merchant, never the raw sheet string, and they match
 *      by token-boundary prefix (see src/lib/rules.ts for the measured reason).
 *   2. A rule is only seeded where Will was CONSISTENT about the vendor. Amazon splits
 *      117/290 across categories and Home Depot spans Home Improvement and Housing —
 *      that is real budgeting, not noise (confirmed by Will 2026-07-26), so those
 *      vendors are deliberately left for the keyword-qualifier and LLM stages rather
 *      than being flattened to a plurality guess that would be wrong ~60% of the time.
 *
 * Run: npx tsx scripts/seed-rules.mts [--dry-run] [--min-support N] [--min-dominance D]
 */
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const arg = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const DRY = process.argv.includes("--dry-run");
const MIN_SUPPORT = arg("--min-support", 2);
const MIN_DOMINANCE = arg("--min-dominance", 0.8);

interface Row { merchant: string; category_id: string; category: string; n: number; total: number }

const rows = (await sql`
  SELECT t.normalized_merchant AS merchant, t.category_id, c.name AS category,
         COUNT(*)::int AS n,
         SUM(COUNT(*)) OVER (PARTITION BY t.normalized_merchant)::int AS total
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
  WHERE t.source = 'sheet' AND t.category_id IS NOT NULL
    AND length(t.normalized_merchant) >= 4
  GROUP BY t.normalized_merchant, t.category_id, c.name
`) as Row[];

// Winner per vendor.
const best = new Map<string, Row>();
for (const r of rows) {
  const cur = best.get(r.merchant);
  if (!cur || r.n > cur.n) best.set(r.merchant, r);
}

const candidates = [...best.values()].map((r) => ({ ...r, dominance: r.n / r.total }));
const chosen = candidates.filter((r) => r.total >= MIN_SUPPORT && r.dominance >= MIN_DOMINANCE);
const rejected = candidates.filter((r) => !(r.total >= MIN_SUPPORT && r.dominance >= MIN_DOMINANCE));

const sheetRows = candidates.reduce((s, r) => s + r.total, 0);
console.log(`vendors: ${candidates.length}  seeding: ${chosen.length}  holding back: ${rejected.length}`);
console.log(`sheet rows covered by seeded vendors: ${chosen.reduce((s, r) => s + r.total, 0)}/${sheetRows}`);
console.log(`\nheld back (ambiguous — these are the LLM/keyword stage's job):`);
for (const r of rejected.filter((r) => r.total >= 10).sort((a, b) => b.total - a.total).slice(0, 12)) {
  console.log(`  ${String(r.total).padStart(4)}  ${r.merchant.padEnd(26)} best=${r.category} ${r.n}/${r.total} (${(100 * r.dominance).toFixed(0)}%)`);
}

if (DRY) {
  console.log("\ndry run — nothing written");
  process.exit(0);
}

let inserted = 0;
const CHUNK = 200;
for (let i = 0; i < chosen.length; i += CHUNK) {
  const c = chosen.slice(i, i + CHUNK);
  const res = (await sql.query(
    `INSERT INTO rules (pattern, match_type, category_id, origin, priority)
     SELECT d.pattern, 'prefix'::rule_match, d.category_id::uuid, 'seed'::rule_origin, d.priority::int
     FROM unnest($1::text[], $2::text[], $3::int[]) AS d(pattern, category_id, priority)
     ON CONFLICT (pattern, match_type, keyword) DO NOTHING
     RETURNING 1`,
    [
      c.map((r) => r.merchant),
      c.map((r) => r.category_id),
      // Longer, more-specific patterns should be considered first when two rules both
      // match ("SAM S CLUB" before "SAM"). Priority is a cheap tiebreak that survives
      // into SQL-side matching later.
      c.map((r) => 100 - Math.min(50, r.merchant.length)),
    ],
  )) as unknown[];
  inserted += Array.isArray(res) ? res.length : 0;
}
console.log(`\ninserted ${inserted} rules (${chosen.length - inserted} already present)`);
