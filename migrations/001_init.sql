-- finance-reports schema, version 1.
--
-- Everything here is backend-neutral: the backend adapter maps Firefly (or the sample
-- dataset) into these tables, and reports read only `report_txn`.

-- The category tree. Ids are stable slugs (`food-and-drink.groceries`) so the decision log
-- stays readable without a join. Seeded from Plaid's taxonomy by the service at startup.
CREATE TABLE category (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.-]*$'),
  parent_id     text REFERENCES category (id),
  name          text NOT NULL CHECK (btrim(name) <> ''),
  kind          text NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  plaid_primary  text,
  plaid_detailed text,
  sort          integer NOT NULL DEFAULT 0,
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
-- A flat backend stores only the name, so names must map back to exactly one category.
CREATE UNIQUE INDEX category_name_key ON category (lower(name));
CREATE INDEX category_parent_idx ON category (parent_id);

-- Rules: the identity row plus immutable versions. A deleted rule keeps its versions.
CREATE TABLE rule (
  id              bigserial PRIMARY KEY,
  current_version integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE rule_version (
  rule_id    bigint NOT NULL REFERENCES rule (id),
  version    integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  PRIMARY KEY (rule_id, version)
);

-- The normalized mirror of the backend's transactions: one row per split.
CREATE TABLE txn (
  id                 bigserial PRIMARY KEY,
  backend            text NOT NULL,
  external_id        text NOT NULL,
  group_id           text,
  date               date NOT NULL,
  amount             numeric(14, 2) NOT NULL, -- signed: negative is money out
  currency           text NOT NULL DEFAULT 'USD',
  type               text NOT NULL CHECK (type IN ('withdrawal', 'deposit', 'transfer')),
  pending            boolean NOT NULL DEFAULT false,
  merchant           text,
  -- merchantKey(merchant, description): what merchant rules and suggestions match on.
  merchant_key       text NOT NULL,
  description        text NOT NULL,
  account_id         text,
  account_name       text,
  counterparty       text,
  plaid_primary      text,
  plaid_detailed     text,
  -- The category name as the backend last reported it, and as we last wrote it.
  backend_category   text,
  category_id        text REFERENCES category (id),
  -- Where category_id came from: the backend's import of Plaid's category (`plaid`), someone
  -- or something else in the backend (`backend`), a rule here (`rule:<id>`), a person here
  -- (`manual`), or nothing (`none`).
  category_provenance text NOT NULL DEFAULT 'none'
    CHECK (category_provenance ~ '^(none|plaid|backend|manual|rule:[0-9]+)$'),
  category_set_at    timestamptz,
  -- category_id differs from what the backend has; the sync loop writes it through.
  backend_dirty      boolean NOT NULL DEFAULT false,
  -- New or changed since rules last looked at it.
  needs_rules        boolean NOT NULL DEFAULT true,
  backend_updated_at timestamptz,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  synced_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (backend, external_id)
);
CREATE INDEX txn_date_idx ON txn (date) WHERE deleted_at IS NULL;
CREATE INDEX txn_category_idx ON txn (category_id);
CREATE INDEX txn_merchant_key_idx ON txn (merchant_key);
CREATE INDEX txn_dirty_idx ON txn (id) WHERE backend_dirty;
CREATE INDEX txn_needs_rules_idx ON txn (id) WHERE needs_rules;

-- Every categorization decision, append-only. See the trigger below.
CREATE TABLE decision_event (
  id               bigserial PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor            text NOT NULL,
  action           text NOT NULL CHECK (action IN
                     ('recategorize', 'rule_create', 'rule_update', 'rule_delete', 'rule_backfill')),
  -- No foreign keys: the log must outlive and never constrain the tables it describes.
  txn_id           bigint,
  txn_snapshot     jsonb,
  old_category_id  text,
  old_provenance   text,
  new_category_id  text,
  new_provenance   text,
  rule_id          bigint,
  rule_version     integer,
  rule_definition  jsonb,
  ui_context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version   integer NOT NULL DEFAULT 1
);
CREATE INDEX decision_event_txn_idx ON decision_event (txn_id);

CREATE FUNCTION decision_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'decision_event is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER decision_event_no_update_delete
  BEFORE UPDATE OR DELETE ON decision_event
  FOR EACH ROW EXECUTE FUNCTION decision_event_append_only();

CREATE TRIGGER decision_event_no_truncate
  BEFORE TRUNCATE ON decision_event
  FOR EACH STATEMENT EXECUTE FUNCTION decision_event_append_only();

-- Small key/value state: the adapter's sync cursor, last full sync time.
CREATE TABLE app_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Login sessions. Only a hash of the cookie value is stored.
CREATE TABLE web_session (
  id_hash     text PRIMARY KEY,
  email       text NOT NULL,
  csrf_token  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Category writes made against the sample backend, so its dataset behaves like a ledger.
CREATE TABLE sample_backend_write (
  external_id   text PRIMARY KEY,
  category_name text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- What every report queries: live transactions with their category, its top-level parent,
-- and `spend` (money out as a positive number, refunds negative; zero for transfers and
-- income/transfer categories).
CREATE VIEW report_txn AS
SELECT
  t.id,
  t.date,
  t.amount::float8 AS amount,
  t.currency,
  t.type,
  t.pending,
  t.merchant,
  t.description,
  t.account_name,
  t.category_id,
  t.category_provenance AS provenance,
  coalesce(top.id, 'uncategorized') AS top_id,
  coalesce(top.name, 'Uncategorized') AS top_name,
  coalesce(c.id, 'uncategorized') AS leaf_id,
  CASE
    WHEN c.id IS NULL THEN 'Uncategorized'
    WHEN c.parent_id IS NULL THEN c.name || ' (unspecified)'
    ELSE c.name
  END AS leaf_name,
  coalesce(c.kind, 'expense') AS kind,
  CASE
    WHEN t.type = 'transfer' THEN 0
    WHEN coalesce(c.kind, 'expense') = 'expense' THEN -t.amount::float8
    ELSE 0
  END AS spend
FROM txn t
LEFT JOIN category c ON c.id = t.category_id
LEFT JOIN category top ON top.id = coalesce(c.parent_id, c.id)
WHERE t.deleted_at IS NULL;
