-- Gifts: a transaction marked as a gift still counts in every report, but the app keeps its
-- merchant (and everything else that would give it away) out of its lists, charts and search;
-- opening it shows them. An honor system, for a shared login. A person marks one by hand, or a
-- gift rule does: a few dates, and optionally what the merchant or the description contains.
ALTER TABLE txn
  ADD COLUMN gift            boolean NOT NULL DEFAULT false,
  -- Where `gift` came from: nothing (`none`), a person here (`manual`, marking it or taking
  -- the mark off, which rules then leave alone), or a gift rule (`rule:<id>`).
  ADD COLUMN gift_provenance text NOT NULL DEFAULT 'none'
    CHECK (gift_provenance ~ '^(none|manual|rule:[0-9]+)$');

-- The decision log records marking a gift and taking the mark off. A constraint only: no row
-- changes, so the append-only triggers have nothing to refuse.
ALTER TABLE decision_event
  DROP CONSTRAINT decision_event_action_check,
  ADD CONSTRAINT decision_event_action_check CHECK (action IN
    ('recategorize', 'rename', 'gift', 'ungift', 'rule_create', 'rule_update', 'rule_delete', 'rule_backfill'));
