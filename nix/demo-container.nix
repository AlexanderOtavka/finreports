# The public demo: the service on the sample data, logged in for everyone (DEMO_MODE), with
# its own throwaway PostgreSQL in /tmp, so that one container is the whole deployment. Every
# start is a fresh database: what a visitor changes is gone when the instance stops.
{
  lib,
  dockerTools,
  writeShellApplication,
  cacert,
  coreutils,
  postgresql_17,
  finreports,
}: let
  start = writeShellApplication {
    name = "finreports-demo";
    runtimeInputs = [coreutils postgresql_17];
    text = ''
      data=/tmp/postgres
      rm -rf "$data"
      initdb -D "$data" -U finreports --auth=trust --no-sync --encoding=UTF8 --locale=C >/dev/null
      # Only a socket in /tmp; nothing to keep, so nothing to flush. mmap rather than
      # /dev/shm, which some container runtimes keep small.
      cat >>"$data/postgresql.conf" <<EOF
      listen_addresses = '''
      unix_socket_directories = '/tmp'
      fsync = off
      full_page_writes = off
      synchronous_commit = off
      shared_buffers = 16MB
      dynamic_shared_memory_type = mmap
      EOF
      pg_ctl -D "$data" -l /tmp/postgres.log -w start >/dev/null
      export PGHOST=/tmp PGUSER=finreports PGDATABASE=postgres
      exec ${lib.getExe finreports}
    '';
  };
in
  dockerTools.buildLayeredImage {
    name = "finreports-demo";
    tag = "latest";
    # initdb and postgres refuse to run as a uid without a passwd entry.
    contents = [
      cacert
      (dockerTools.fakeNss.override {
        extraPasswdLines = ["finreports:x:1000:1000:finreports:/tmp:/bin/false"];
        extraGroupLines = ["finreports:x:1000:"];
      })
    ];
    extraCommands = ''
      mkdir -m 1777 tmp
    '';
    config = {
      Cmd = [(lib.getExe start)];
      User = "1000:1000";
      ExposedPorts."8080/tcp" = {};
      Env = [
        "NODE_ENV=production"
        "BACKEND=sample"
        "DEMO_MODE=true"
        "PORT=8080"
        "HOST=0.0.0.0"
        "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
      ];
      Labels = {
        "org.opencontainers.image.source" = "https://github.com/AlexanderOtavka/finreports";
        "org.opencontainers.image.description" = "finreports public demo, on generated sample data";
        "org.opencontainers.image.licenses" = "MIT";
      };
    };
  }
