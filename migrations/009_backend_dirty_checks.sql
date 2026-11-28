-- `backend_dirty` stays a stored column (whether a category needs writing depends on the
-- category's name, in another table), but only a category chosen here (by a person or a rule) is
-- ever written to the backend, and only one that exists: the write-through joins on it.
--
-- A dirty row with no category could never be written, so it is not waiting for anything.
UPDATE txn SET backend_dirty = false WHERE backend_dirty AND category_id IS NULL;

ALTER TABLE txn
  ADD CONSTRAINT txn_backend_dirty_provenance_check
    CHECK (NOT backend_dirty OR category_provenance ~ '^(manual|rule:[0-9]+)$'),
  ADD CONSTRAINT txn_backend_dirty_category_check
    CHECK (NOT backend_dirty OR category_id IS NOT NULL);
