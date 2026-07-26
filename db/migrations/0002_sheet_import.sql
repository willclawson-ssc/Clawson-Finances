-- 0002_sheet_import.sql — carry the "Clawson Finances" Google Sheet history into the ledger.
--
-- Decision (2026-07-26, Will): load the WHOLE sheet, not just the pre-CSV window, and
-- reconcile the sheet<->CSV overlap AUTOMATICALLY later. The sheet is the source of
-- truth. That makes provenance load-bearing: the reconciliation pass has to be able to
-- pick out exactly the rows that came from the sheet, so they get their own source
-- rather than being folded into 'manual' alongside rows Will types into the app.
--
-- NOTE: no BEGIN/COMMIT. ALTER TYPE ... ADD VALUE may not be used by later statements in
-- the same transaction, so this file relies on psql's autocommit.

-- 'manual' stays reserved for rows a human enters IN THE APP.
ALTER TYPE txn_source ADD VALUE IF NOT EXISTS 'sheet';

-- Stable natural key of a source row ('gsheet:<tab row number>'). The Form only ever
-- appends, so the row number does not shift and re-running the importer is a no-op.
-- The csv fingerprint index cannot do this job: it is partial (WHERE source = 'csv') and
-- keys on descriptor+amount, which hand-typed rows repeat legitimately.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_external_ref_key
  ON transactions (external_ref) WHERE external_ref IS NOT NULL;

-- The category string EXACTLY as the sheet held it, before canonicalization.
-- Distinct from bank_category (a bank's own taxonomy, a weak hint) — this one is a human
-- decision and is the seed corpus for `rules`. Kept raw because the sheet carries 62
-- distinct strings for a 24-category taxonomy: case variants plus typos
-- ('Utlities', 'Food (Restauants)', 'misc inome'). Canonicalization is lossy, and when a
-- rollup later looks wrong the original string is what makes it debuggable.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_category text;

-- The sheet names a payment method per row, so history spans accounts that have no CSV
-- export at all (FGB Visa, closed 2023; Cash; a one-off "Dad's checking").
COMMENT ON COLUMN accounts.supports_csv IS
  'False for manual-only accounts: Bonvenu (no export offered), plus sheet-era accounts '
  'like FGB Visa and Cash. The UI must not imply every account is importable.';
