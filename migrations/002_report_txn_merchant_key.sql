-- report_txn gains merchant_key, so reports can group by merchant the way rules match them.
-- CREATE OR REPLACE VIEW may only append columns, so the existing ones keep their order.
CREATE OR REPLACE VIEW report_txn AS
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
  END AS spend,
  t.merchant_key
FROM txn t
LEFT JOIN category c ON c.id = t.category_id
LEFT JOIN category top ON top.id = coalesce(c.parent_id, c.id)
WHERE t.deleted_at IS NULL;
