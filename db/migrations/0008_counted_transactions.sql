-- 0008_counted_transactions.sql — one definition of "which rows count".
--
-- ⚠️ THE BUG THIS FIXES PREDATES TRANSFER DETECTION AND IS BIGGER THAN IT.
-- The sheet (2023-03-01 → 2026-07-22) and the CSVs (2025-01-25 → 2026-07-24) were both
-- loaded in full, deliberately (docs §2e), so ~3,067 rows in the overlap describe the same
-- purchases twice. Every read path that sums `transactions` has therefore been reporting
-- roughly double for the overlap period — including the account balances on the dashboard,
-- which showed USAA Checking at +$202,592 by counting 18 months of history twice.
--
-- Rather than repeat the slicing rule in every query (where it will drift, and where the
-- next person to write a SUM will simply forget it), it lives here once:
--
--   * before CSV coverage begins  → the sheet is the record
--   * after it begins             → the CSVs are, PLUS sheet rows for accounts the CSVs
--                                   do not cover
--
-- ⚠️ That last clause is load-bearing, not defensive. Dad's Checking has
-- supports_csv = false and one $3,720 sheet row inside the CSV era; a plain
-- `source = 'csv'` filter drops it silently. Cash, FGB Visa and Bonvenu are permanently in
-- that position — no export exists for them — so the rule must key on account coverage.
--
-- The boundary is DERIVED, never hardcoded: importing older statements moves it on its own
-- instead of quietly mis-slicing the history.
--
-- This is a stopgap with a known end date. Once reconciliation merges the overlapping pairs
-- (each loser getting merged_into_id, which this view already filters), the era rule stops
-- mattering and the view can collapse to just the merged/active filter.

CREATE VIEW counted_transactions AS
WITH boundary AS (
  SELECT MIN(txn_date) AS csv_start
  FROM transactions
  WHERE source = 'csv' AND merged_into_id IS NULL
)
SELECT t.*,
       CASE WHEN t.txn_date < b.csv_start THEN 'sheet' ELSE 'csv' END AS era
FROM transactions t
JOIN accounts a ON a.id = t.account_id
CROSS JOIN boundary b
WHERE t.merged_into_id IS NULL
  AND (
    -- No CSV era yet at all: nothing has been imported, so the sheet is all there is.
    b.csv_start IS NULL
    OR t.txn_date < b.csv_start
    OR t.source = 'csv'
    OR NOT a.supports_csv
  );

COMMENT ON VIEW counted_transactions IS
  'Transactions that count exactly once: the sheet before CSV coverage begins, the CSVs '
  'after, plus sheet rows for accounts with no CSV export. Excludes merged duplicates. '
  'SUM over this, never over transactions, or the sheet/CSV overlap double-counts.';
