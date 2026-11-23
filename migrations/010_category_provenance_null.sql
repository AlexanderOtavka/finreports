-- `category_provenance` is null exactly when there is no category: nothing chose one, so there is
-- nothing to say where it came from. No more `none`, and no `plaid` or `backend` for a category
-- the backend has but that maps to none of ours (a Plaid category outside the taxonomy, say):
-- such a transaction is uncategorized here either way, and rules treat it the same.
--
-- A category with `none` as its source would have to be given one. No code path makes one, so
-- refuse to guess rather than pick a source (which decides whether rules may change it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM txn WHERE category_id IS NOT NULL AND category_provenance = 'none') THEN
    RAISE EXCEPTION 'txn has rows with a category but category_provenance none';
  END IF;
END
$$;

ALTER TABLE txn
  ALTER COLUMN category_provenance DROP NOT NULL,
  ALTER COLUMN category_provenance DROP DEFAULT,
  DROP CONSTRAINT txn_category_provenance_check;
UPDATE txn SET category_provenance = NULL WHERE category_id IS NULL;
ALTER TABLE txn
  ADD CONSTRAINT txn_category_provenance_check
    CHECK (category_provenance ~ '^(plaid|backend|manual|rule:[0-9]+)$'),
  ADD CONSTRAINT txn_category_provenance_category_check
    CHECK ((category_provenance IS NULL) = (category_id IS NULL));

-- decision_event's old_provenance and new_provenance (and a snapshot's categoryProvenance) are
-- null for no category from here on, where earlier events say `none`. These are the schema 3
-- events 008 introduced; no event rows change, so the append-only triggers have nothing to refuse.
