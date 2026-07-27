-- 0007_transfers.sql — transfer detection: make a spending total possible.
--
-- The problem, measured on the real ledger: the USAA credit card "nets" +$1,598.71 over
-- 18 months, because card payments arrive on the card as inflows and cancel the purchases
-- they paid for. Every dashboard figure has therefore been labelled "net change" rather
-- than "spent" (docs §2f). This migration is the schema half of fixing that.
--
-- ⚠️ THE FINDING THAT SHAPED THIS MIGRATION: only 156 of 763 transfer legs in the ledger
-- have a counterparty leg to pair with. The other 607 move money to somewhere that is NOT
-- in this ledger — Marcus, Goldman Sachs, Fidelity, GuideStone, Venmo, and Bonvenu (which
-- has no CSV export at all and will never be importable). A design built only on pairing
-- would leave ~$60k of movements still counted as spending.
--
-- So exclusion and pairing are deliberately SEPARATE mechanisms:
--
--   1. EXCLUSION (single-leg, the big win) — a row whose canonical vendor is kind
--      'transfer' is not spending, full stop, whether or not the other side is visible.
--      Driven entirely by canonical_stores.kind, which already resolves 100% of rows.
--   2. PAIRING (two-leg, the confidence win) — where both legs ARE present, link them so
--      the movement is one object and can be shown as such.
--
-- ⚠️ NO GROUP ROW IS CREATED FOR SINGLE-LEG TRANSFERS, on purpose. A singleton group
-- would carry no information that canonical_stores.kind doesn't already carry, and it is
-- one more piece of state to drift out of sync. If the counterparty account is imported
-- later, the pairing pass finds the pair then and creates the group then; nothing is lost
-- by not pre-creating it.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. transfer_groups — one row per money movement that has BOTH legs in the ledger.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE transfer_groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Absolute magnitude of the movement. Stored because it is the group's identity in the
  -- UI ("$2,142.57 card payment"), and the legs carry it with opposite signs.
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),

  -- Earliest leg date. The two legs are 0-3 days apart (measured: Discover 07/10 <->
  -- USAA 07/13), and budgeting should attribute the movement to when it started.
  occurred_on  date NOT NULL,

  -- 'pair_match' — found by the automated two-leg matcher
  -- 'human'      — linked by hand in the UI, including resolving an ambiguous match
  detected_by  text NOT NULL CHECK (detected_by IN ('pair_match', 'human')),

  -- Only set for pair_match. 1.0 means exactly one candidate existed; a lower score
  -- records that the matcher chose between several and the choice could be wrong.
  confidence   numeric(4,3),

  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- transfer_group_id has existed since 0001 as a bare uuid with no referent. Every value
-- is NULL (no detection has ever run), so the constraint can be added without a backfill.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_transfer_group_fkey
  FOREIGN KEY (transfer_group_id) REFERENCES transfer_groups(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. WHY a row is excluded — not just that it is.
--
-- excluded_from_totals has been a bare boolean since 0001. Once things start setting it,
-- "why is TXN-004821 missing from my spending?" has to be answerable, and the reasons are
-- genuinely different in kind: a transfer is real money that moved, a reward is money that
-- was never spent or earned in the first place.
-- ─────────────────────────────────────────────────────────────────────────────
-- 'duplicate' is here because merge already excludes its loser (src/lib/transactions.ts):
-- omitting it broke the merge integration tests immediately, which is the constraint
-- doing its job — every writer of excluded_from_totals must now name its reason.
ALTER TABLE transactions ADD COLUMN exclusion_reason text
  CHECK (exclusion_reason IN ('transfer', 'reward', 'duplicate', 'manual'));

-- Keep the flag and the reason from contradicting each other. Enforced in the database
-- rather than in application code because scripts, the import path and the UI can all
-- write these two columns.
ALTER TABLE transactions ADD CONSTRAINT transactions_exclusion_reason_ck
  CHECK (excluded_from_totals = (exclusion_reason IS NOT NULL));

-- The spend query's hot path: everything NOT excluded.
CREATE INDEX transactions_spendable_idx ON transactions (txn_date)
  WHERE NOT excluded_from_totals AND merged_into_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Rewards & cashback finally get a home.
--
-- Open since 2026-07-25 (docs §3): AUTOMATIC STATEMENT CREDIT (x7) and CASHBACK BONUS
-- REDEMPTION are negative on a liability account, which makes them look exactly like a
-- card payment to the transfer matcher. They are neither spending nor income — counting
-- them as income overstates earnings, and leaving them in spend understates it.
--
-- category_kind has had a 'reward' value since 0001 but no category ever used it; the 24
-- seeded categories came from the sheet's taxonomy, which has no such bucket.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO categories (name, kind) VALUES ('Rewards & Cashback', 'reward')
ON CONFLICT (name) DO NOTHING;

COMMIT;
