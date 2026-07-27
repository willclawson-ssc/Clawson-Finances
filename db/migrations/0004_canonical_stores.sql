-- 0004_canonical_stores.sql — one row per real-world vendor.
--
-- Will's design (2026-07-26), and it is better than the regex approach it replaces.
-- Rather than teaching normalizeMerchant to strip cities, store numbers and possessive
-- apostrophes — a rule set that can never be complete and that mangles vendors whose
-- real name contains a number — we keep a table of TRUE store names and resolve each
-- incoming descriptor against it. "MOTEL 8 BOSSIER CITY" survives as Motel 8 because
-- "Motel 8" is itself a canonical entry and wins on longest match; no stripping rule has
-- to be clever enough to know the 8 is part of the brand.
--
-- Built from all 1,666 distinct merchant strings in the ledger, clustered by seven
-- parallel subagents and reconciled: 1,666 aliases in, 1,666 accounted for, zero missing,
-- zero invented, zero claimed twice. 789 vendors.
--
-- Naming note: Will called this `canonical_store_name`; renamed to `canonical_stores` to
-- match the plural-noun convention of accounts/categories/transactions/rules.

BEGIN;

-- Beyond tidiness: 'transfer' is what lets card payments drop out of spending totals
-- (docs §2f), and it comes from the vendor rather than being re-derived per transaction.
CREATE TYPE store_kind AS ENUM ('store', 'transfer', 'income', 'fee', 'other');

CREATE TABLE canonical_stores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The true name, properly cased, as a human writes it: "McDonald's", "The Home Depot".
  -- This is what the UI shows — never the bank's mangled descriptor.
  name       text NOT NULL UNIQUE,
  kind       store_kind NOT NULL DEFAULT 'store',
  -- Why an ambiguous clustering call was made the way it was. Kept because these are
  -- judgement calls that a future reader (or Will) may want to overturn.
  note       text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Aliases are a separate table, not an array column: resolution needs to find the
-- LONGEST alias matching a descriptor, which is an indexed lookup over patterns, not an
-- array scan.
CREATE TABLE store_aliases (
  -- The normalized (uppercase) merchant string. Primary key: one alias resolves to
  -- exactly one vendor, enforced by the database rather than by import discipline.
  pattern    text PRIMARY KEY,
  store_id   uuid NOT NULL REFERENCES canonical_stores(id) ON DELETE CASCADE,
  -- 'seed' = mined from existing history; 'human' = a merge made in the UI later.
  origin     text NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'human')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_aliases_store_idx ON store_aliases (store_id);
-- Resolution walks candidate prefixes of a descriptor, so it looks patterns up by
-- text_pattern_ops for the LIKE-style comparisons.
CREATE INDEX store_aliases_pattern_idx ON store_aliases (pattern text_pattern_ops);

-- Resolved vendor. normalized_merchant STAYS: it is the raw material resolution runs on,
-- and keeping it means the whole table can be re-resolved after the alias set improves.
ALTER TABLE transactions
  ADD COLUMN canonical_store_id uuid REFERENCES canonical_stores(id);
CREATE INDEX transactions_store_idx ON transactions (canonical_store_id);
-- Finding rows whose vendor could not be resolved — the review queue's feed.
CREATE INDEX transactions_unresolved_idx ON transactions (txn_date)
  WHERE canonical_store_id IS NULL;

COMMIT;
