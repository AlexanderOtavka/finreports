-- More about each transaction, to tell an unclear merchant apart: the merchant's website and
-- where the purchase happened (Plaid's, as the Plaid connector writes them into Firefly's
-- external URL and latitude/longitude), and the ledger's notes and tags.
ALTER TABLE txn
  ADD COLUMN website   text,
  ADD COLUMN latitude  float8,
  ADD COLUMN longitude float8,
  ADD COLUMN notes     text,
  ADD COLUMN tags      text[] NOT NULL DEFAULT '{}';
