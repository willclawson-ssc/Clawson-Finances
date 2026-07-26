-- 0003_txn_type.sql — keep the source's own transaction-type label.
--
-- Apple Card's export carries a Type column (Purchase 42 / Payment 2 / Credit 1 /
-- Debit 1 in the 46-row sample) that the adapter was parsing and discarding. It is the
-- only authoritative, non-heuristic "this is a card payment, not spending" signal in any
-- of the four exports, which is exactly what transfer detection needs — and it cannot be
-- backfilled without re-downloading every statement. Cheap to keep, expensive to regret.
--
-- Deliberately NOT an enum: this is whatever the institution called it, verbatim, and a
-- new institution must not require a migration to be importable.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS txn_type text;

COMMENT ON COLUMN transactions.txn_type IS
  'Institution-supplied transaction type, verbatim (Apple Card: Purchase/Payment/'
  'Credit/Debit). NULL where the export has no such column (USAA, Discover). A hint '
  'for transfer detection, not a normalized field.';
