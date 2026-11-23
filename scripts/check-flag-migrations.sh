#!/usr/bin/env bash
# Checks migrations 007-010 (the txn flag cleanup, #48) against a copy of the real database,
# without changing it: dumps finance_reports from the cluster (pg_dump, read-only, as the
# nightly backup does), restores it into a throwaway PostgreSQL in a temporary directory,
# applies the migrations there, and compares every row before and after. Prints counts and
# transaction ids only, never what a transaction says. The copy is deleted on exit.
#
#   scripts/check-flag-migrations.sh [REF]
#
# REF is the finreports commit whose migrations to check (default: this branch's tip on GitHub).
# DUMP=/path/to/finance_reports.dump checks a dump file instead of taking one (a nightly
# one from /data/firefly/backups, say). KUBECTL overrides the kubectl command.
set -euo pipefail

REPO=AlexanderOtavka/finreports
REF="${1:-t3/audit-redundant-boolean-columns}"
NEW_MIGRATIONS=(007_merchant_dirty_generated.sql 008_gift_source.sql 009_backend_dirty_checks.sql 010_category_provenance_null.sql)

if [[ "${INNER:-}" != 1 ]]; then
  WORK="$(mktemp -d /tmp/finreports-check.XXXXXX)"
  chmod 700 "$WORK"
  cleanup() {
    if [[ -f "$WORK/pg/postmaster.pid" ]]; then
      nix shell nixpkgs#postgresql_17 --command pg_ctl -D "$WORK/pg" -m immediate stop >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK"
  }
  trap cleanup EXIT

  echo "== Fetching the migrations at $REF"
  mkdir "$WORK/src"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$WORK/src" --strip-components=1
  echo "   $(ls "$WORK/src/migrations" | tr '\n' ' ')"

  if [[ -n "${DUMP:-}" ]]; then
    echo "== Using the dump $DUMP"
    cp "$DUMP" "$WORK/prod.dump"
  else
    echo "== Dumping finance_reports from firefly-postgresql-0 (read-only)"
    ${KUBECTL:-kubectl} -n firefly exec firefly-postgresql-0 -c postgresql -- \
      sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d finance_reports --format=custom' \
      >"$WORK/prod.dump"
  fi
  echo "   $(du -h "$WORK/prod.dump" | cut -f1)"

  INNER=1 WORK="$WORK" nix shell nixpkgs#postgresql_17 --command bash "$WORK/src/scripts/check-flag-migrations.sh"
  exit $?
fi

# ---- Inside `nix shell nixpkgs#postgresql_17`, with WORK set up. ----

echo "== Starting a throwaway PostgreSQL $(postgres --version | awk '{print $3}')"
initdb -D "$WORK/pg" -U postgres --auth=trust --no-sync -E UTF8 >/dev/null
pg_ctl -D "$WORK/pg" -l "$WORK/pg.log" -o "-c listen_addresses='' -k $WORK -c fsync=off" -w start >/dev/null
export PGHOST="$WORK" PGUSER=postgres PGDATABASE=chk
createdb chk
pg_restore --no-owner --no-privileges --exit-on-error -d chk "$WORK/prod.dump"

q() { psql --no-psqlrc -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"; }
FAILED=0
check() { # check "label" "SQL returning a count that must be 0"
  local n
  n="$(q "$2")"
  if [[ "$n" == 0 ]]; then echo "OK    $1"; else echo "FAIL  $1: $n"; FAILED=1; fi
}

applied="$(q "SELECT string_agg(name, ' ' ORDER BY name) FROM schema_migration")"
echo "   applied in production: $applied"
for m in "${NEW_MIGRATIONS[@]}"; do
  if grep -qw "$m" <<<"$applied"; then echo "Production already has $m; nothing to check."; exit 1; fi
done

echo
echo "== Before migrating: what production holds"
q "SELECT format('   %s transactions (%s deleted), %s decision events, %s rules',
     (SELECT count(*) FROM txn), (SELECT count(*) FROM txn WHERE deleted_at IS NOT NULL),
     (SELECT count(*) FROM decision_event), (SELECT count(*) FROM rule))"
q "SELECT format('   gifts: %s', coalesce(string_agg(format('%s/%s=%s', gift, gift_provenance, n), ', '), 'none'))
   FROM (SELECT gift, regexp_replace(gift_provenance, '[0-9]+', 'N') AS gift_provenance, count(*) AS n FROM txn GROUP BY 1, 2 ORDER BY 1, 2) g"
q "SELECT format('   category provenance: %s', string_agg(format('%s%s=%s', p, CASE WHEN has THEN '' ELSE ' (no category)' END, n), ', '))
   FROM (SELECT regexp_replace(category_provenance, '[0-9]+', 'N') AS p, category_id IS NOT NULL AS has, count(*) AS n FROM txn GROUP BY 1, 2 ORDER BY 1, 2) c"
q "SELECT format('   waiting to be written: %s categories, %s merchants', count(*) FILTER (WHERE backend_dirty), count(*) FILTER (WHERE merchant_dirty)) FROM txn"

echo
echo "== Rows the migrations refuse (each one stops the deploy; ids only)"
q "SELECT format('   007 (merchant differs from the backend''s, not waiting): %s %s', count(*), coalesce('ids ' || string_agg(id::text, ',' ORDER BY id), ''))
   FROM txn WHERE NOT merchant_dirty AND merchant IS DISTINCT FROM backend_merchant"
q "SELECT format('   009 (category waiting to be written that no person or rule chose): %s %s', count(*), coalesce('ids ' || string_agg(id::text, ',' ORDER BY id), ''))
   FROM txn WHERE backend_dirty AND category_id IS NOT NULL AND category_provenance !~ '^(manual|rule:[0-9]+)$'"
q "SELECT format('   010 (a category with provenance none): %s %s', count(*), coalesce('ids ' || string_agg(id::text, ',' ORDER BY id), ''))
   FROM txn WHERE category_id IS NOT NULL AND category_provenance = 'none'"
echo "   And rows they change on purpose:"
q "SELECT format('   %s gifts with no source (kept marked, as manual), %s rule sources on non-gifts (dropped)',
     count(*) FILTER (WHERE gift AND gift_provenance = 'none'), count(*) FILTER (WHERE NOT gift AND gift_provenance LIKE 'rule:%')) FROM txn"
q "SELECT format('   %s waiting category writes with no category (cleared: they could never be written)', count(*)) FROM txn WHERE backend_dirty AND category_id IS NULL"
q "SELECT format('   %s merchants marked waiting but equal to the backend''s (no longer waiting)', count(*)) FROM txn WHERE merchant_dirty AND merchant IS NOT DISTINCT FROM backend_merchant"

# Everything as it was, to compare against.
TABLES=(txn category rule rule_version decision_event app_state web_session sample_backend_write)
q "CREATE SCHEMA pre"
for t in "${TABLES[@]}"; do q "CREATE TABLE pre.$t AS SELECT * FROM public.$t"; done
q "CREATE TABLE pre.report_txn AS SELECT * FROM public.report_txn"

echo
echo "== Applying the migrations, each in its own transaction like the app does"
for m in "${NEW_MIGRATIONS[@]}"; do
  if ! out="$( { echo "BEGIN;"; cat "$WORK/src/migrations/$m"; echo "INSERT INTO schema_migration (name) VALUES ('$m'); COMMIT;"; } \
      | psql --no-psqlrc -X -q -v ON_ERROR_STOP=1 2>&1)"; then
    echo "FAIL  $m refused to apply (production would stop on it and roll it back, unchanged):"
    echo "$out" | sed 's/^/      /'
    exit 1
  fi
  echo "OK    $m"
done

echo
echo "== Comparing every row with how it was"
# What each old row should now be: the new columns derived from the old ones.
EXPECTED="SELECT id, to_jsonb(p) - 'gift_provenance' || jsonb_build_object(
    'gift_source', CASE WHEN p.gift_provenance = 'manual' THEN CASE WHEN p.gift THEN 'manual' ELSE 'manual:off' END
                        WHEN p.gift AND p.gift_provenance LIKE 'rule:%' THEN p.gift_provenance
                        WHEN p.gift THEN 'manual' END,
    'merchant_dirty', p.merchant IS DISTINCT FROM p.backend_merchant,
    'backend_dirty', p.backend_dirty AND p.category_id IS NOT NULL,
    'category_provenance', CASE WHEN p.category_id IS NOT NULL THEN p.category_provenance END) AS row
  FROM pre.txn p"
check "txn: every row is exactly the old one with its flags in the new shape" \
  "SELECT count(*) FROM ($EXPECTED) e FULL JOIN (SELECT id, to_jsonb(t) AS row FROM public.txn t) n USING (id) WHERE e.row IS DISTINCT FROM n.row"
check "txn: no gift marked or unmarked" \
  "SELECT count(*) FROM pre.txn p JOIN public.txn t USING (id) WHERE p.gift IS DISTINCT FROM t.gift"
check "txn: no category, merchant or amount changed" \
  "SELECT count(*) FROM pre.txn p JOIN public.txn t USING (id) WHERE (p.category_id, p.merchant, p.amount, p.date, p.deleted_at) IS DISTINCT FROM (t.category_id, t.merchant, t.amount, t.date, t.deleted_at)"
for t in category rule rule_version decision_event app_state web_session sample_backend_write; do
  check "$t: identical" \
    "SELECT (SELECT count(*) FROM (SELECT * FROM pre.$t EXCEPT ALL SELECT * FROM public.$t) a) + (SELECT count(*) FROM (SELECT * FROM public.$t EXCEPT ALL SELECT * FROM pre.$t) b)"
done
check "report_txn: what the reports read is unchanged (but provenance none, now null)" \
  "SELECT count(*) FROM (SELECT id, to_jsonb(r) || jsonb_build_object('provenance', CASE WHEN r.category_id IS NOT NULL THEN r.provenance END) AS row FROM pre.report_txn r) e
   FULL JOIN (SELECT id, to_jsonb(r) AS row FROM public.report_txn r) n USING (id) WHERE e.row IS DISTINCT FROM n.row"
check "every constraint is validated" "SELECT count(*) FROM pg_constraint WHERE NOT convalidated"
check "the decision log still refuses UPDATE" \
  "SELECT 2 - count(*) FROM pg_trigger WHERE tgname IN ('decision_event_no_update_delete', 'decision_event_no_truncate')"

echo
echo "== After"
q "SELECT format('   gift_source: %s', string_agg(format('%s=%s', s, n), ', '))
   FROM (SELECT coalesce(regexp_replace(gift_source, '[0-9]+', 'N'), 'null') AS s, count(*) AS n FROM txn GROUP BY 1 ORDER BY 1) g"
q "SELECT format('   waiting to be written: %s categories, %s merchants', count(*) FILTER (WHERE backend_dirty), count(*) FILTER (WHERE merchant_dirty)) FROM txn"

echo
if [[ "$FAILED" == 0 ]]; then
  echo "ALL OK: these migrations apply cleanly to a copy of production and change only what they should."
else
  echo "SOMETHING DIFFERS: see FAIL above. Production is untouched."
  exit 1
fi
