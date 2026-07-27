-- 0005_store_rules.sql — point the deterministic layer at vendors, not strings.
--
-- Rules originally matched a text pattern against normalized_merchant. With
-- canonical_stores in place that is the wrong key: the vendor is already resolved by
-- longest-match at ingest, so a rule should name the VENDOR and inherit every alias it
-- will ever gain. Seeding a rule for "The Home Depot" now covers THE HOME DEPOT,
-- THE HOME DEPOT BOSSIER CITY and any future store number, for free.
--
-- Pattern rules are kept, not removed: a pattern can still express something a vendor
-- cannot (a substring across vendors), and dropping the column would throw away a
-- working mechanism for no gain.

BEGIN;

ALTER TABLE rules ADD COLUMN store_id uuid REFERENCES canonical_stores(id) ON DELETE CASCADE;
ALTER TABLE rules ALTER COLUMN pattern DROP NOT NULL;
ALTER TABLE rules ADD CONSTRAINT rules_target_check
  CHECK (pattern IS NOT NULL OR store_id IS NOT NULL);

-- One rule per (vendor, qualifier). The keyword is what separates "Sam's Club + gas"
-- (Transportation) from bare "Sam's Club" (Groceries) — measured in the sheet's own
-- notes, where every Sam's Club Transportation row literally says "gas".
CREATE UNIQUE INDEX rules_store_keyword_key ON rules (store_id, COALESCE(keyword, ''))
  WHERE store_id IS NOT NULL;

CREATE INDEX rules_store_idx ON rules (store_id) WHERE active AND store_id IS NOT NULL;

COMMIT;
