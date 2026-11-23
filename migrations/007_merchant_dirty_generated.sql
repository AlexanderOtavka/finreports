-- `merchant_dirty` is derived: a merchant waits to be written to the backend exactly when it
-- differs from what the backend last reported (or what we last wrote). Every write already kept
-- it equal to that comparison; now the database does, and no query can set it wrong.
--
-- A row whose merchant differs from the backend's without being dirty would start being written
-- to the backend. No code path makes one, so refuse to guess rather than write it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM txn WHERE NOT merchant_dirty AND merchant IS DISTINCT FROM backend_merchant) THEN
    RAISE EXCEPTION 'txn has rows whose merchant differs from backend_merchant but are not merchant_dirty';
  END IF;
END
$$;

ALTER TABLE txn DROP COLUMN merchant_dirty;
ALTER TABLE txn ADD COLUMN merchant_dirty boolean
  GENERATED ALWAYS AS (merchant IS DISTINCT FROM backend_merchant) STORED;
CREATE INDEX txn_merchant_dirty_idx ON txn (id) WHERE merchant_dirty;
