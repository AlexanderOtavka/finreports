-- One column says whether a transaction is a gift and why: `gift_source` is null when nothing
-- marked it, `manual` when a person marked it, `manual:off` when a person took the mark off
-- (rules leave both alone), or `rule:<id>` when a gift rule marked it. `gift` is derived from it,
-- so a gift with no source, or a rule's mark that marks nothing, can no longer be stored.
ALTER TABLE txn ADD COLUMN gift_source text
  CHECK (gift_source ~ '^(manual|manual:off|rule:[0-9]+)$');

-- A gift with no source keeps its mark, as if by hand: unmarking it would give it away. A rule's
-- source on a transaction that is not a gift marks nothing, so it goes.
UPDATE txn SET gift_source = CASE
    WHEN gift_provenance = 'manual' THEN CASE WHEN gift THEN 'manual' ELSE 'manual:off' END
    WHEN gift AND gift_provenance LIKE 'rule:%' THEN gift_provenance
    WHEN gift THEN 'manual'
  END
WHERE gift OR gift_provenance <> 'none';

ALTER TABLE txn DROP COLUMN gift, DROP COLUMN gift_provenance;
ALTER TABLE txn ADD COLUMN gift boolean
  GENERATED ALWAYS AS (gift_source IS NOT NULL AND gift_source <> 'manual:off') STORED;

-- Snapshots from here on carry `giftSource` (as above) instead of `giftProvenance`. A schema 2
-- snapshot's (gift, giftProvenance) reads as a source the same way the update above does. Only
-- a default changes: no event rows change, so the append-only triggers have nothing to refuse.
ALTER TABLE decision_event ALTER COLUMN schema_version SET DEFAULT 3;
