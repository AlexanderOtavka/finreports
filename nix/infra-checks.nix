# Checks of infra/ and the demo commands that need no Google account: `nix flake check`.
{
  lib,
  runCommand,
  writeShellScriptBin,
  callPackage,
  jq,
  python3,
  infra,
}: let
  settings = import ../infra/settings.nix;

  # Records each call in $GCLOUD_LOG, fails the first $GCLOUD_FAIL_DEPLOYS deploys (as a
  # conflict would), and answers `describe` from $GCLOUD_DESCRIBE.
  gcloud = writeShellScriptBin "gcloud" ''
    echo "$*" >>"$GCLOUD_LOG"
    case "$*" in
      "run deploy "*)
        failed="$(cat "$GCLOUD_LOG.failed" 2>/dev/null || echo 0)"
        if [ "$failed" -lt "''${GCLOUD_FAIL_DEPLOYS:-0}" ]; then
          echo $((failed + 1)) >"$GCLOUD_LOG.failed"
          echo "conflict" >&2
          exit 1
        fi
        ;;
      "run services describe "*"--format=json"*) cat "$GCLOUD_DESCRIBE" ;;
      "run services describe "*"--format=value(status.url)"*) echo "https://finreports-demo-x.a.run.app" ;;
    esac
  '';
  demo = callPackage ./demo.nix {google-cloud-sdk = gcloud;};

  digest = "sha256:${lib.fixedWidthString 64 "a" ""}";
  service = "${settings.demoService} --project ${settings.project} --region ${settings.region} --quiet";
  image = "${settings.demoImage}@${digest}";
in {
  # The gcloud calls `demo deploy` and `demo untag` make, and what they print.
  demo =
    runCommand "demo-check" {
      nativeBuildInputs = [demo jq];
    } ''
      export GCLOUD_LOG=$PWD/gcloud.log DEMO_RETRY_SECONDS=0
      export GCLOUD_DESCRIBE=$PWD/describe.json
      cat >describe.json <<'JSON'
      {"status": {"url": "https://finreports-demo-x.a.run.app", "traffic": [
        {"percent": 100, "revisionName": "finreports-demo-00007"},
        {"tag": "main", "revisionName": "finreports-demo-00007", "url": "https://main---finreports-demo-x.a.run.app"},
        {"tag": "pr-16", "revisionName": "finreports-demo-00009", "url": "https://pr-16---finreports-demo-x.a.run.app"}
      ]}}
      JSON
      expect() {
        if ! diff -u <(printf '%s\n' "$@") "$GCLOUD_LOG"; then
          echo "unexpected gcloud calls" >&2
          exit 1
        fi
        rm -f "$GCLOUD_LOG" "$GCLOUD_LOG.failed"
      }
      same() {
        if [ "$1" != "$2" ]; then
          echo "expected '$2', got '$1'" >&2
          exit 1
        fi
      }

      # A PR's demo, after one conflict: a tagged revision without traffic, at the tag's URL.
      url="$(GCLOUD_FAIL_DEPLOYS=1 demo deploy ${digest} --pr 16)"
      same "$url" https://pr-16---finreports-demo-x.a.run.app/reports/
      expect \
        "run deploy ${service} --image ${image} --tag pr-16 --no-traffic" \
        "run deploy ${service} --image ${image} --tag pr-16 --no-traffic" \
        "run services describe ${service} --format=json"

      # Main's: tagged `main`, then the traffic follows the tag.
      url="$(demo deploy ${digest})"
      same "$url" https://finreports-demo-x.a.run.app/reports/
      expect \
        "run deploy ${service} --image ${image} --tag main --no-traffic" \
        "run services update-traffic ${service} --to-tags main=100" \
        "run services describe ${service} --format=value(status.url)"

      # A deploy that keeps failing fails, after its retries.
      if GCLOUD_FAIL_DEPLOYS=9 demo deploy ${digest} --pr 16 >/dev/null 2>&1; then
        echo "a failing deploy succeeded" >&2
        exit 1
      fi
      same "$(grep -c "run deploy" "$GCLOUD_LOG")" 5
      rm -f "$GCLOUD_LOG" "$GCLOUD_LOG.failed"

      # Untag: only a tag that is there.
      demo untag 16
      expect \
        "run services describe ${service} --format=json" \
        "run services update-traffic ${service} --remove-tags pr-16"
      demo untag 17 2>/dev/null
      expect "run services describe ${service} --format=json"

      # Nothing is called with arguments it does not understand.
      for args in "" "deploy" "deploy sha256:abc" "deploy ${digest} --pr" "deploy ${digest} --pr x" \
        "deploy ${digest} 16" "untag" "untag pr-16" "untag 16 17" "rm 16"; do
        # shellcheck disable=SC2086
        if demo $args 2>/dev/null; then
          echo "demo $args was accepted" >&2
          exit 1
        fi
      done
      if [ -e "$GCLOUD_LOG" ]; then
        echo "bad arguments reached gcloud" >&2
        exit 1
      fi
      touch $out
    '';

  # The rendered configuration against the provider's schema, with only the providers in
  # the Nix store and no network.
  infra-config = runCommand "infra-config-check" {} ''
    cp ${infra.config} config.tf.json
    export HOME=$PWD
    ${infra.tofu}/bin/tofu init -backend=false -input=false -no-color -plugin-dir=${infra.pluginDir}
    ${infra.tofu}/bin/tofu validate -no-color
    touch $out
  '';

  killswitch = runCommand "killswitch-check" {nativeBuildInputs = [python3];} ''
    cp ${../infra/killswitch.py} killswitch.py
    cp ${../infra/killswitch_test.py} killswitch_test.py
    python3 -m unittest -v killswitch_test
    touch $out
  '';
}
