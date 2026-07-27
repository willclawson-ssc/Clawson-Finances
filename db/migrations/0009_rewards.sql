-- 0009_rewards.sql — cashback and reward points get their own category (Will's call: A).
--
-- The problem: Discover cashback, USAA reward points and statement credits arrive as
-- positive amounts and the vendor table typed them 'income', which put them in the same
-- bucket as payroll. 57 rows / $1,797.28 of overstated earnings.
--
-- Will's decision (2026-07-26), of the two options put to him:
--   A. its own category, separate from BOTH income and spending   <- chosen
--   B. reduce the spending of the month it lands in
-- A wins because B quietly makes a month look cheaper than it was. So these rows carry the
-- 'Rewards & Cashback' category (added in 0007) and are excluded from totals with
-- exclusion_reason = 'reward' — visible as rewards, absent from spent and received.
--
-- ⚠️ AND THE REAL FIX IS THE TRIGGER, NOT THE BACKFILL. The exclusion rule "a row's vendor
-- kind decides whether it counts" was previously enforced only by scripts/detect-transfers.mts,
-- run by hand. The import route never applied it — so every CSV upload silently landed new
-- card payments and cashback as spending, and the totals drifted wrong again until someone
-- remembered to re-run the script. An invariant that every writer has to remember is not an
-- invariant. It lives in the database now, next to the CHECK from 0007.

-- ALTER TYPE ... ADD VALUE is committed on its own: Postgres forbids USING a new enum label
-- in the same transaction that added it, and the UPDATE below does exactly that.
ALTER TYPE store_kind ADD VALUE IF NOT EXISTS 'reward';

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Reclassify the reward vendors away from 'income'.
--
-- Named explicitly rather than matched on a pattern. 'Fetch Rewards' is 67 rows / $100k of
-- REAL PAYROLL ("FETCH REWARDS, L PAYROLL" — an actual employer), and any regex over
-- /reward/ would silently reclassify a six-figure income stream as cashback.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE canonical_stores SET kind = 'reward'
WHERE name IN ('Reward Points Redemption', 'Automatic Statement Credit',
               'USAA Rewards', 'Cashback Bonus Redemption');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The invariant: vendor kind decides whether a row counts toward totals.
--
-- ⚠️ A HUMAN DECISION OUTRANKS THE TRIGGER. 'manual' (Will excluded it himself) and
-- 'duplicate' (a merge did it) are never touched — otherwise re-resolving a vendor would
-- silently undo a deliberate choice, or a merged loser would rejoin the totals.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION apply_vendor_exclusion() RETURNS trigger AS $$
DECLARE
  vendor_kind store_kind;
BEGIN
  IF NEW.exclusion_reason IN ('manual', 'duplicate') THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO vendor_kind FROM canonical_stores WHERE id = NEW.canonical_store_id;

  IF vendor_kind IN ('transfer', 'reward') THEN
    NEW.excluded_from_totals := true;
    NEW.exclusion_reason := vendor_kind::text;
  ELSE
    -- Covers the un-resolve case too: clearing canonical_store_id, or repointing a row at
    -- an ordinary store, must return it to the totals rather than leave it stranded.
    NEW.excluded_from_totals := false;
    NEW.exclusion_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- UPDATE OF canonical_store_id, not UPDATE: this must fire when a row's vendor changes, but
-- must NOT fire on an ordinary edit, or a user toggling excluded_from_totals by hand would
-- have it reverted in the same statement.
CREATE TRIGGER transactions_vendor_exclusion
  BEFORE INSERT OR UPDATE OF canonical_store_id ON transactions
  FOR EACH ROW EXECUTE FUNCTION apply_vendor_exclusion();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill the existing reward rows: category + exclusion.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE transactions t
SET category_id = c.id,
    category_source = 'rule',
    excluded_from_totals = true,
    exclusion_reason = 'reward',
    updated_at = now()
FROM canonical_stores s, categories c
WHERE s.id = t.canonical_store_id AND s.kind = 'reward'
  AND c.name = 'Rewards & Cashback'
  AND t.merged_into_id IS NULL
  AND t.exclusion_reason IS DISTINCT FROM 'reward';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Seed rules so the categorization cascade agrees with the backfill.
--
-- Without these, the rules engine (once wired into import, Stage 2) would re-decide these
-- vendors from the sheet's history, where they were filed as income. Keyed on store_id so
-- the rule inherits every alias the vendor gains later (migration 0005).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO rules (store_id, category_id, match_type, origin, priority)
SELECT s.id, c.id, 'exact', 'seed', 50
FROM canonical_stores s, categories c
WHERE s.kind = 'reward' AND c.name = 'Rewards & Cashback'
ON CONFLICT (store_id, COALESCE(keyword, '')) WHERE store_id IS NOT NULL
DO UPDATE SET category_id = EXCLUDED.category_id;

COMMIT;
