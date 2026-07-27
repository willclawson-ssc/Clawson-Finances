/**
 * Load the canonical vendor table and resolve every transaction against it.
 *
 * Source: ~/docker/finances-app/canonical/canonical.json — 789 vendors covering all
 * 1,666 distinct merchant strings in the ledger, built by seven parallel subagents from
 * the real data and reconciled (0 missing, 0 invented, 0 claimed twice).
 *
 * Idempotent: vendors upsert by name, aliases by pattern, and resolution is a pure
 * function of (normalized_merchant, alias set) — so re-running after adding aliases
 * simply improves coverage. Nothing is destroyed; normalized_merchant is untouched.
 *
 * Run: npx tsx scripts/load-canonical-stores.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { buildStoreIndex, resolveStore, type StoreAlias } from "../src/lib/stores";

const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const file = path.join(os.homedir(), "docker/finances-app/canonical/canonical.json");

interface SeedStore { name: string; kind: string; aliases: string[]; note?: string }
const { stores } = JSON.parse(fs.readFileSync(file, "utf8")) as { stores: SeedStore[] };
console.log(`seed: ${stores.length} vendors, ${stores.reduce((s, x) => s + x.aliases.length, 0)} aliases`);

const CHUNK = 300;
for (let i = 0; i < stores.length; i += CHUNK) {
  const c = stores.slice(i, i + CHUNK);
  await sql.query(
    `INSERT INTO canonical_stores (name, kind, note)
     SELECT d.name, d.kind::store_kind, NULLIF(d.note, '')
     FROM unnest($1::text[], $2::text[], $3::text[]) AS d(name, kind, note)
     ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, note = EXCLUDED.note`,
    [c.map((s) => s.name), c.map((s) => s.kind), c.map((s) => s.note ?? "")],
  );
}

const rows = (await sql`SELECT id, name FROM canonical_stores`) as { id: string; name: string }[];
const idByName = new Map(rows.map((r) => [r.name, r.id]));

const pairs = stores.flatMap((s) => s.aliases.map((a) => ({ pattern: a, storeId: idByName.get(s.name)! })));
for (let i = 0; i < pairs.length; i += CHUNK) {
  const c = pairs.slice(i, i + CHUNK);
  await sql.query(
    `INSERT INTO store_aliases (pattern, store_id)
     SELECT d.pattern, d.store_id::uuid
     FROM unnest($1::text[], $2::text[]) AS d(pattern, store_id)
     ON CONFLICT (pattern) DO UPDATE SET store_id = EXCLUDED.store_id`,
    [c.map((p) => p.pattern), c.map((p) => p.storeId)],
  );
}
console.log(`loaded ${rows.length} vendors, ${pairs.length} aliases`);

// ── resolve every transaction ────────────────────────────────────────────────
const aliases = (await sql`SELECT pattern, store_id AS "storeId" FROM store_aliases`) as StoreAlias[];
const idx = buildStoreIndex(aliases);

const txns = (await sql`
  SELECT id, normalized_merchant FROM transactions
`) as { id: string; normalized_merchant: string }[];

const updates = txns
  .map((t) => ({ id: t.id, storeId: resolveStore(t.normalized_merchant, idx) }))
  .filter((u): u is { id: string; storeId: string } => u.storeId !== null);

for (let i = 0; i < updates.length; i += 500) {
  const c = updates.slice(i, i + 500);
  await sql.query(
    `UPDATE transactions t SET canonical_store_id = d.store_id::uuid
     FROM unnest($1::text[], $2::text[]) AS d(id, store_id)
     WHERE t.id = d.id::uuid`,
    [c.map((u) => u.id), c.map((u) => u.storeId)],
  );
}

console.log(`resolved ${updates.length}/${txns.length} transactions ` +
  `(${(100 * updates.length / txns.length).toFixed(1)}%)`);
