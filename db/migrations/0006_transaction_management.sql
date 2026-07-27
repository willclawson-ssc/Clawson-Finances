-- 0006_transaction_management.sql — transaction IDs, editability, merge, receipts.
--
-- Four capabilities, one migration, because they interlock:
--   1. a human-usable Transaction ID
--   2. an immutable as-imported snapshot, so transactions become EDITABLE safely
--   3. reversible merge, for duplicate transactions
--   4. receipt + email storage
--
-- ⚠️ THE NON-OBVIOUS PART IS (2), AND IT IS WHY THIS MIGRATION IS SHAPED THIS WAY.
-- `fingerprint` is a generated column over (account, date, raw_description, amount,
-- occurrence_n) and it is what makes CSV re-import idempotent. If a user corrects an
-- amount, the fingerprint changes, the next statement import no longer recognises the
-- row, and the ORIGINAL is silently re-inserted as a new transaction. A correction would
-- manufacture a duplicate.
--
-- The fix follows Will's own data/metadata split: metadata is what the bank sent and
-- never changes; data is what the ledger currently believes and is freely editable. The
-- fingerprint is therefore rebuilt over the IMPORTED values, which are frozen forever.
-- Editing an amount can no longer break dedup, because dedup stopped looking at it.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Transaction ID — TXN-000001. The uuid stays the foreign-key target; this is
--    purely the handle a human reads, says out loud and searches for.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE txn_display_seq;

ALTER TABLE transactions ADD COLUMN display_id text;

-- Backfill in ledger order so the numbers run chronologically rather than in whatever
-- order rows happened to be inserted (the sheet and four CSVs were loaded separately).
UPDATE transactions t SET display_id = 'TXN-' || lpad(o.rn::text, 6, '0')
FROM (
  SELECT id, row_number() OVER (ORDER BY txn_date, created_at, id) AS rn
  FROM transactions
) o
WHERE o.id = t.id;

SELECT setval('txn_display_seq', (SELECT count(*) FROM transactions));

ALTER TABLE transactions
  ALTER COLUMN display_id SET NOT NULL,
  ALTER COLUMN display_id SET DEFAULT 'TXN-' || lpad(nextval('txn_display_seq')::text, 6, '0');
CREATE UNIQUE INDEX transactions_display_id_key ON transactions (display_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The as-imported snapshot (immutable metadata).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE transactions
  ADD COLUMN imported_txn_date    date,
  ADD COLUMN imported_amount      numeric(14,2),
  ADD COLUMN imported_description text;

-- Everything currently in the table is untouched-since-import by definition: no edit UI
-- has ever existed. So the current values ARE the imported values.
UPDATE transactions
SET imported_txn_date = txn_date,
    imported_amount = amount,
    imported_description = raw_description;

-- Rebuild the fingerprint over the frozen columns. Dropping the generated column drops
-- the partial unique index with it, so both are recreated below.
ALTER TABLE transactions DROP COLUMN fingerprint;

ALTER TABLE transactions ADD COLUMN fingerprint text GENERATED ALWAYS AS (
  md5(account_id::text
      -- days-since-epoch, not ::text: date->text is only STABLE (it honours DateStyle)
      -- and a generated column requires an IMMUTABLE expression.
      || '|' || (COALESCE(imported_txn_date, txn_date) - DATE '1970-01-01')::text
      || '|' || COALESCE(imported_description, raw_description)
      || '|' || COALESCE(imported_amount, amount)::text
      || '|' || occurrence_n::text)
) STORED;

CREATE UNIQUE INDEX transactions_fingerprint_csv_key
  ON transactions (fingerprint) WHERE source = 'csv';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Edit audit trail. One row per FIELD changed, not per save, so "who last touched
--    the amount" is a lookup rather than a diff of blobs.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE transaction_edits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  field          text NOT NULL,
  old_value      text,
  new_value      text,
  -- Clerk user id. Nullable so a worker/script edit is representable as "not a person".
  edited_by      text,
  note           text,
  edited_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_edits_txn_idx ON transaction_edits (transaction_id, edited_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Merge — reversible by construction.
--
-- The merged-away row is NOT deleted. It keeps its id, its display_id and its
-- provenance, and merely points at its survivor; every read path filters on
-- merged_into_id IS NULL. Undo is therefore a single UPDATE, and the audit question
-- "where did TXN-004821 go?" stays answerable forever.
--
-- This is the tool for the ~2,668 sheet<->CSV duplicate pairs deliberately left in the
-- ledger (docs §2e) — they get resolved interactively instead of by a batch job.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE transactions
  ADD COLUMN merged_into_id uuid REFERENCES transactions(id) ON DELETE SET NULL;
CREATE INDEX transactions_merged_into_idx ON transactions (merged_into_id)
  WHERE merged_into_id IS NOT NULL;
-- Every ledger read filters this out; make that path indexed rather than a seq scan.
CREATE INDEX transactions_active_idx ON transactions (txn_date DESC)
  WHERE merged_into_id IS NULL;

CREATE TABLE transaction_merges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survivor_id  uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  merged_id    uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  reason       text,
  merged_by    text,
  -- Full pre-merge row of the survivor, so undo restores any field the merge
  -- overwrote (a merge may adopt the loser's category or notes).
  survivor_snapshot jsonb,
  merged_at    timestamptz NOT NULL DEFAULT now(),
  undone_at    timestamptz
);
CREATE INDEX transaction_merges_survivor_idx ON transaction_merges (survivor_id);
CREATE UNIQUE INDEX transaction_merges_open_key ON transaction_merges (merged_id)
  WHERE undone_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Receipts — photo and email.
--
-- ⚠️ Image BYTES do not go in Postgres. Neon free tier is 0.5 GB and the ledger is
-- currently 19 MB; a few hundred 2 MB receipt photos would fill it and suspend the
-- database. Bytes live in Vercel Blob (the account is on Pro), and this table holds the
-- URL, hash and size. Email HTML is text and stays here, but in this side table rather
-- than on the hot transactions row, where it would bloat every ledger query.
--
-- transaction_id is NULLABLE on purpose: a harvested email receipt often arrives before
-- the matching statement row does, and must be storable while it waits.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE receipt_kind AS ENUM ('photo', 'email');

CREATE TABLE receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  kind           receipt_kind NOT NULL,

  -- photo
  blob_url       text,
  blob_pathname  text,
  content_hash   text,          -- sha256; dedups a receipt uploaded twice
  byte_size      integer,
  mime_type      text,

  -- email
  email_from     text,
  email_to       text,          -- which address it was sent to (Will's ask)
  email_subject  text,
  email_message_id text,        -- RFC 822 Message-ID; dedups a re-harvested message
  email_html     text,
  email_text     text,
  received_at    timestamptz,

  -- Structured extraction (store, date, total, line items) from the Claude worker.
  parsed         jsonb,
  parsed_at      timestamptz,
  parse_error    text,

  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipts_txn_idx ON receipts (transaction_id);
CREATE UNIQUE INDEX receipts_hash_key ON receipts (content_hash) WHERE content_hash IS NOT NULL;
CREATE UNIQUE INDEX receipts_message_key ON receipts (email_message_id) WHERE email_message_id IS NOT NULL;
-- Receipts still waiting to be attached to a transaction.
CREATE INDEX receipts_unmatched_idx ON receipts (created_at) WHERE transaction_id IS NULL;

COMMIT;
