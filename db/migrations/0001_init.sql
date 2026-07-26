-- 0001_init.sql — finances app core schema
-- Design: ~/docs/finances-app.md (§3 backbone, §5 categorization). Every non-obvious
-- choice below traces to a finding from the real CSV exports analyzed 2026-07-25.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- ─────────────────────────────────────────────────────────────────────────────
-- accounts
-- account_type is MANDATORY and drives sign normalization. USAA exports checking
-- and credit card in an IDENTICAL format with OPPOSITE semantics (purchases are
-- negative on the asset file, positive on the liability file), so sign can never
-- be inferred from the file itself. Getting this wrong silently inverts an entire
-- account's spend.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE account_type AS ENUM ('asset', 'liability');

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  institution   text NOT NULL,
  type          account_type NOT NULL,
  -- false for Bonvenu: the bank offers no CSV export, so it is manual-entry only.
  -- The UI must not imply every account is importable.
  supports_csv  boolean NOT NULL DEFAULT true,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- categories — the 23 buckets from the sheet's Labels!Form Cats.
-- `kind` exists so rewards/cashback stay representable while the taxonomy
-- question is still open (docs §9): statement credits and cashback redemptions
-- are negative but are neither income nor spending, and would skew rollups.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE category_kind AS ENUM ('spend', 'income', 'transfer', 'reward');

CREATE TABLE categories (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL UNIQUE,
  kind     category_kind NOT NULL DEFAULT 'spend',
  active   boolean NOT NULL DEFAULT true
);

-- ─────────────────────────────────────────────────────────────────────────────
-- statement_imports — one row per uploaded CSV, so a re-import is auditable and
-- an ingest can be attributed or rolled back.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE statement_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  adapter       text NOT NULL,          -- 'usaa' | 'discover' | 'applecard'
  filename      text,
  row_count     integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  range_start   date,
  range_end     date,
  imported_at   timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- transactions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE txn_status AS ENUM ('posted', 'pending', 'scheduled');
CREATE TYPE txn_source AS ENUM ('csv', 'manual', 'receipt');

CREATE TABLE transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Use the TRANSACTION date for budgeting. Apple/Discover also carry a
  -- clearing/post date; USAA carries only one.
  txn_date            date NOT NULL,
  post_date           date,

  -- Two descriptor strings, deliberately NOT interchangeable (docs §3):
  --   raw_description       — exactness matters, used by the dedup fingerprint
  --   normalized_merchant   — generalization matters, used by rules + the LLM
  -- Raw descriptors embed per-purchase random tokens
  -- (AMAZON MKTPL*V98087A63 AMZN.COM/BILLWA18O7YA8SW4E), so without
  -- normalization ~100% of Amazon rows look like brand-new vendors and the
  -- deterministic rules layer collapses.
  raw_description     text NOT NULL,
  normalized_merchant text NOT NULL,

  -- LEDGER-NORMALIZED SIGN, independent of account_type:
  --   negative = money out (spending), positive = money in (income/refund).
  -- The adapter applies account_type to get here; downstream code never
  -- re-reasons about institution quirks.
  amount              numeric(14,2) NOT NULL,

  status              txn_status NOT NULL DEFAULT 'posted',
  source              txn_source NOT NULL,

  -- Weak hint only, never truth: taxonomies differ per bank and quality varies
  -- wildly (USAA-card is 'Category Pending' for 31% of rows; Apple is coarse).
  bank_category       text,

  -- Apple Card exposes real per-user attribution on a shared card
  -- (William Clawson x43, Mary Allred x3) and Mary is the other Clerk user.
  purchased_by        text,

  category_id         uuid REFERENCES categories(id),
  -- Provenance of category_id, so the feedback loop can tell apart a human
  -- decision from a rule hit or an LLM guess.
  category_source     text CHECK (category_source IN ('rule','llm','human','bank')),
  category_confidence numeric(4,3),

  -- Card payments appear on BOTH legs (all 10 Discover "INTERNET PAYMENT"
  -- rows match a USAA checking outflow), so summing spend across accounts
  -- inflates it by every payment made. Transfers link and drop out of totals.
  transfer_group_id   uuid,
  excluded_from_totals boolean NOT NULL DEFAULT false,

  notes               text,
  statement_import_id uuid REFERENCES statement_imports(id) ON DELETE SET NULL,

  -- Occurrence ordinal within (account, date, raw_description, amount) for this
  -- file. REQUIRED: legitimate exact duplicates are common — usaa-sample-B has
  -- 19 repeating keys / 35 rows, e.g. ANTHROPIC $44.00 twice on 2026-06-14.
  -- A naive (date, description, amount) fingerprint would silently delete real
  -- spending. With the ordinal, re-import matches ordinal-for-ordinal and stays
  -- idempotent WITHOUT collapsing true repeats.
  occurrence_n        smallint NOT NULL DEFAULT 1,

  -- txn_date is rendered as days-since-epoch rather than ::text: date->text is
  -- only STABLE (it honours the DateStyle setting), and a generated column
  -- requires an IMMUTABLE expression. Integer arithmetic sidesteps that.
  fingerprint text GENERATED ALWAYS AS (
    md5(account_id::text
        || '|' || (txn_date - DATE '1970-01-01')::text
        || '|' || raw_description
        || '|' || amount::text
        || '|' || occurrence_n::text)
  ) STORED,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Idempotent re-import: overlapping date ranges become a no-op.
-- Only applies to CSV rows — manual entries legitimately have no ordinal
-- discipline and must never collide with each other.
CREATE UNIQUE INDEX transactions_fingerprint_csv_key
  ON transactions (fingerprint) WHERE source = 'csv';

CREATE INDEX transactions_account_date_idx ON transactions (account_id, txn_date DESC);
CREATE INDEX transactions_uncategorized_idx ON transactions (txn_date)
  WHERE category_id IS NULL;
-- Pending->posted reconciliation and manual<->CSV matching both need fuzzy
-- merchant comparison; pg_trgm keeps it in-database rather than in app code.
CREATE INDEX transactions_merchant_trgm_idx
  ON transactions USING gin (normalized_merchant gin_trgm_ops);
-- Supports matching incoming Posted rows against existing Pending ones.
CREATE INDEX transactions_pending_idx ON transactions (account_id, amount, txn_date)
  WHERE status <> 'posted';
CREATE INDEX transactions_transfer_group_idx ON transactions (transfer_group_id)
  WHERE transfer_group_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- line_items — from parsed receipts. The founding reason for a relational model:
-- one purchase can be partly Groceries and partly Restaurants (whole-bean coffee
-- + a latte at the same coffee shop), which a single-category Form row cannot
-- represent.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE line_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  description    text NOT NULL,
  quantity       numeric(10,3),
  amount         numeric(14,2) NOT NULL,
  category_id    uuid REFERENCES categories(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX line_items_txn_idx ON line_items (transaction_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- splits — category allocation of a transaction. Distinct from line_items:
-- line items are what the receipt literally said; splits are how the money is
-- attributed. A transaction is either wholly category_id, or split into rows
-- here (which must sum to transactions.amount — enforced in the app, not here,
-- so partial edits are possible in the UI).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE splits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id    uuid NOT NULL REFERENCES categories(id),
  amount         numeric(14,2) NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX splits_txn_idx ON splits (transaction_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- rules — the deterministic layer. Measured against real exports: ~200 rules
-- cover ~81% of 2,323 transactions, so the LLM only ever sees a thin novel tail.
-- Self-growing: every human correction and confident LLM call becomes a rule.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE rule_match AS ENUM ('exact', 'prefix', 'contains');
CREATE TYPE rule_origin AS ENUM ('seed', 'human', 'llm');

CREATE TABLE rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Matched against transactions.normalized_merchant, never raw_description.
  pattern     text NOT NULL,
  match_type  rule_match NOT NULL DEFAULT 'exact',
  -- Optional qualifier for multi-category vendors: "sam s club" + "gas"
  -- -> Transportation, else Groceries.
  keyword     text,
  category_id uuid NOT NULL REFERENCES categories(id),
  priority    integer NOT NULL DEFAULT 100,
  origin      rule_origin NOT NULL DEFAULT 'seed',
  hit_count   integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pattern, match_type, keyword)
);
CREATE INDEX rules_lookup_idx ON rules (pattern) WHERE active;

-- ─────────────────────────────────────────────────────────────────────────────
-- review_queue — low-confidence LLM output and anything needing a human call,
-- including manual<->CSV merge candidates surfaced for confirmation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE review_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  reason         text NOT NULL,   -- 'low_confidence' | 'merge_candidate' | 'new_vendor' | ...
  suggestion     jsonb,           -- LLM proposal: category or split + reasoning
  candidate_txn_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_queue_open_idx ON review_queue (created_at)
  WHERE resolved_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER transactions_touch BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Seed the taxonomy (docs §5, from the sheet's Labels!Form Cats).
INSERT INTO categories (name, kind) VALUES
  ('Baby Stuff','spend'), ('Business Expenses','spend'), ('Credit Card Pmts','transfer'),
  ('Food (Groceries)','spend'), ('Food (Restaurants)','spend'), ('Gifts & Offerings','spend'),
  ('Housing','spend'), ('Medical Expenses','spend'), ('Pets','spend'), ('Phone','spend'),
  ('Savings','transfer'), ('Tithe','spend'), ('Transportation','spend'), ('Utilities','spend'),
  ('Personal Spending','spend'), ('MISC','spend'), ('Travel','spend'), ('Entertainment','spend'),
  ('Home Improvement','spend'), ('Christmas','spend'), ('Future Item 3','spend'),
  ('W2 Income','income'), ('1099 Income','income'), ('MISC Income','income');

COMMIT;
