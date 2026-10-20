-- Rules can fill in a missing merchant (schema 2 rules, from the rules builder), and the
-- merchant is written back to the backend like a category is.
--
-- `merchant` stays the merchant everything shows and matches on; `backend_merchant` is what the
-- backend last reported (null: it has none, like an imported statement's "(no name)" payee).
ALTER TABLE txn
  ADD COLUMN backend_merchant    text,
  -- Where `merchant` came from: the backend (`backend`) or a rule here (`rule:<id>`).
  ADD COLUMN merchant_provenance text NOT NULL DEFAULT 'backend'
    CHECK (merchant_provenance ~ '^(backend|rule:[0-9]+)$'),
  -- `merchant` differs from what the backend has; the sync loop writes it through.
  ADD COLUMN merchant_dirty      boolean NOT NULL DEFAULT false;
UPDATE txn SET backend_merchant = merchant;
CREATE INDEX txn_merchant_dirty_idx ON txn (id) WHERE merchant_dirty;

-- The decision log says what happened to the merchant too. New columns only: no row changes,
-- so the append-only triggers have nothing to refuse. Events from here on are schema 2.
ALTER TABLE decision_event
  ADD COLUMN old_merchant text,
  ADD COLUMN new_merchant text,
  ALTER COLUMN schema_version SET DEFAULT 2;

-- Merchant writes made against the sample backend.
ALTER TABLE sample_backend_write ADD COLUMN merchant_name text;
