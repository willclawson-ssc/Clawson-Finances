/**
 * Read-only survey of the exported "Clawson Finances" Form-responses tab.
 *
 * The sheet has TWO uses and they must not be conflated (docs §2e): it is the seed
 * corpus for the `rules` table, and — only for dates the CSV exports don't cover — a
 * source of historical ledger rows. This script measures both before anything is
 * written, since nothing in the schema stops sheet rows double-counting against CSV
 * rows (the unique fingerprint index is partial: WHERE source = 'csv').
 *
 * Run: npx tsx scripts/analyze-sheet.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Papa from "papaparse";
import { normalizeMerchant, parseAmount, parseDate } from "../src/lib/normalize";

const file = path.join(os.homedir(), "docker/finances-app/samples/sheet-form-responses.csv");
const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(file, "utf8"), {
  header: true,
  skipEmptyLines: true,
});
const rows = parsed.data;
console.log(`columns: ${JSON.stringify(parsed.meta.fields)}`);
console.log(`rows: ${rows.length}`);

const col = {
  date: "Date",
  payee: "Payee/Remitter",
  desc: "Description ",
  amount: "Amount",
  method: "Method of Payment",
  category: "Category",
  kind: "Income or Expense?",
};

function tally(vals: (string | undefined)[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of vals) {
    const k = (v ?? "").trim() || "(blank)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return new Map([...m].sort((a, b) => b[1] - a[1]));
}

const show = (label: string, m: Map<string, number>, limit = 40) => {
  console.log(`\n── ${label} (${m.size} distinct)`);
  for (const [k, n] of [...m].slice(0, limit)) console.log(`   ${String(n).padStart(5)}  ${k}`);
  if (m.size > limit) console.log(`   … ${m.size - limit} more`);
};

// ── dates ────────────────────────────────────────────────────────────────────
const dates = rows.map((r) => parseDate(r[col.date]));
const bad = dates.filter((d) => !d).length;
const ok = dates.filter(Boolean).sort() as string[];
console.log(`\ndate range: ${ok[0]} → ${ok[ok.length - 1]}   (unparseable: ${bad})`);
const byYear = tally(ok.map((d) => d.slice(0, 4)));
console.log(`by year: ${[...byYear].sort().map(([y, n]) => `${y}=${n}`).join("  ")}`);

// Rows predating the earliest CSV coverage (2025-01-25) are the ONLY ones safe to
// import as ledger history without a reconciliation pass.
const CSV_START = "2025-01-25";
console.log(`rows before ${CSV_START}: ${ok.filter((d) => d < CSV_START).length}` +
  `   on/after: ${ok.filter((d) => d >= CSV_START).length}`);

// ── shape ────────────────────────────────────────────────────────────────────
show("Method of Payment", tally(rows.map((r) => r[col.method])));
show("Income or Expense?", tally(rows.map((r) => r[col.kind])));
show("Category", tally(rows.map((r) => r[col.category])), 60);

const amounts = rows.map((r) => parseAmount(r[col.amount]));
console.log(`\namounts: unparseable=${amounts.filter((a) => a === null).length}` +
  `  negative=${amounts.filter((a) => (a ?? 0) < 0).length}` +
  `  zero=${amounts.filter((a) => a === 0).length}`);

// ── rule-seed potential ──────────────────────────────────────────────────────
// Vendor names here were hand-typed, so they lack the per-purchase random tokens real
// descriptors carry. They must go through normalizeMerchant() or a seeded rule can
// never match an imported transaction (docs §2e).
const pairs = new Map<string, Map<string, number>>();
for (const r of rows) {
  const v = normalizeMerchant(r[col.payee] ?? "");
  const c = (r[col.category] ?? "").trim();
  if (!v || v === "UNKNOWN" || !c) continue;
  if (!pairs.has(v)) pairs.set(v, new Map());
  const m = pairs.get(v)!;
  m.set(c, (m.get(c) ?? 0) + 1);
}
const vendors = [...pairs].map(([v, m]) => {
  const sorted = [...m].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  return { vendor: v, top: sorted[0][0], topN: sorted[0][1], total, distinct: sorted.length };
}).sort((a, b) => b.total - a.total);

console.log(`\n── normalized vendors: ${vendors.length}`);
const unanimous = vendors.filter((v) => v.distinct === 1).length;
console.log(`   single-category: ${unanimous}   multi-category: ${vendors.length - unanimous}`);
console.log(`   seen once: ${vendors.filter((v) => v.total === 1).length}`);
const cum = (n: number) => vendors.slice(0, n).reduce((s, v) => s + v.total, 0);
for (const n of [10, 25, 50, 100, 200, 400]) {
  console.log(`   top ${String(n).padStart(3)} vendors → ${(100 * cum(n) / rows.length).toFixed(1)}% of sheet rows`);
}
console.log("\n   top 25 vendors (vendor | dominant category | agreement):");
for (const v of vendors.slice(0, 25)) {
  console.log(`   ${String(v.total).padStart(4)}  ${v.vendor.padEnd(28)} ${v.top.padEnd(20)} ${v.topN}/${v.total}`);
}
console.log("\n   worst-disagreement vendors (candidates for a keyword qualifier):");
for (const v of vendors.filter((v) => v.distinct > 1).sort((a, b) => (b.total - b.topN) - (a.total - a.topN)).slice(0, 15)) {
  console.log(`   ${String(v.total).padStart(4)}  ${v.vendor.padEnd(28)} ${v.top} ${v.topN}/${v.total} (${v.distinct} cats)`);
}
