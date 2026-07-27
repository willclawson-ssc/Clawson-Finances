/**
 * Seed the deterministic `rules` layer from the sheet's human category choices,
 * keyed on CANONICAL VENDOR rather than on a merchant string.
 *
 * Why the rewrite: string patterns were measured at 55.4% coverage of real CSV rows, but
 * that number was partly an artefact of vendor fragmentation. "THE HOME DEPOT" and
 * "HOME DEPOT" were separate buckets, and splitting a vendor's history in two made one
 * half look far more consistent than Will actually is — the first bucket scored 92% on
 * Home Improvement while the second scored 36%. Unified, The Home Depot is 152/205 =
 * 74%, which is the truth. Fragmentation was inflating confidence, not coverage.
 *
 * So the seeded set gets SMALLER and more honest: 43.8% of CSV rows at ~96.7% expected
 * accuracy. The right way to win back the rest is a keyword qualifier, not a lower bar —
 * the excluded vendors are multi-category on purpose (Will's budgeting), and the sheet's
 * own notes separate them cleanly (every Sam's Club "Transportation" row says "gas").
 *
 * Measured tradeoff, for the record:
 *   dominance ≥ 0.6 → 66.9% coverage, 87.7% expected accuracy
 *   dominance ≥ 0.7 → 54.4% coverage, 92.6%
 *   dominance ≥ 0.8 → 43.8% coverage, 96.7%   <- chosen
 *   dominance ≥ 0.9 → 39.6% coverage, 98.1%
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

interface Row {
  store_id: string; store_name: string; category_id: string; category: string;
  n: number; total: number;
}

const rows = (await sql`
  SELECT t.canonical_store_id AS store_id, s.name AS store_name,
         t.category_id, c.name AS category,
         COUNT(*)::int AS n,
         SUM(COUNT(*)) OVER (PARTITION BY t.canonical_store_id)::int AS total
  FROM transactions t
  JOIN canonical_stores s ON s.id = t.canonical_store_id
  JOIN categories c ON c.id = t.category_id
  WHERE t.source = 'sheet' AND t.category_id IS NOT NULL
  GROUP BY t.canonical_store_id, s.name, t.category_id, c.name
`) as Row[];

const best = new Map<string, Row>();
for (const r of rows) {
  const cur = best.get(r.store_id);
  if (!cur || r.n > cur.n) best.set(r.store_id, r);
}

const candidates = [...best.values()].map((r) => ({ ...r, dominance: r.n / r.total }));
const chosen = candidates.filter((r) => r.total >= MIN_SUPPORT && r.dominance >= MIN_DOMINANCE);
const held = candidates.filter((r) => !(r.total >= MIN_SUPPORT && r.dominance >= MIN_DOMINANCE));

console.log(`vendors with history: ${candidates.length}  seeding: ${chosen.length}  holding back: ${held.length}`);
console.log(`\nheld back — multi-category ON PURPOSE; these want a keyword qualifier, not a lower threshold:`);
for (const r of held.filter((r) => r.total >= 40).sort((a, b) => b.total - a.total).slice(0, 8)) {
  console.log(`  ${String(r.total).padStart(4)}  ${r.store_name.padEnd(20)} best=${r.category} ${r.n}/${r.total} (${(100 * r.dominance).toFixed(0)}%)`);
}

if (DRY) { console.log("\ndry run — nothing written"); process.exit(0); }

// Replace the previous string-pattern seed wholesale: those rules are superseded by
// vendor rules and would otherwise double-match. Human and LLM rules are left alone.
const del = (await sql`
  DELETE FROM rules WHERE origin = 'seed' AND store_id IS NULL RETURNING 1
`) as unknown[];
console.log(`\nremoved ${del.length} superseded string-pattern seed rules`);

let inserted = 0;
const CHUNK = 200;
for (let i = 0; i < chosen.length; i += CHUNK) {
  const c = chosen.slice(i, i + CHUNK);
  const res = (await sql.query(
    `INSERT INTO rules (store_id, category_id, origin, match_type, priority)
     SELECT d.store_id::uuid, d.category_id::uuid, 'seed'::rule_origin,
            'exact'::rule_match, 100
     FROM unnest($1::text[], $2::text[]) AS d(store_id, category_id)
     ON CONFLICT (store_id, COALESCE(keyword, '')) WHERE store_id IS NOT NULL DO NOTHING
     RETURNING 1`,
    [c.map((r) => r.store_id), c.map((r) => r.category_id)],
  )) as unknown[];
  inserted += Array.isArray(res) ? res.length : 0;
}
console.log(`inserted ${inserted} vendor rules`);
