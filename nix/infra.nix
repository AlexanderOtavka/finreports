# `nix run .#infra -- <tofu args>`: renders infra/ (Terranix) to config.tf.json in
# infra/.work, and runs OpenTofu there. State is in the GCS bucket; `infra bootstrap` creates
# that bucket and runs the first apply. See infra/README.md.
#
# Providers come from the Nix store only, pinned by flake.lock like everything else (the
# weekly `nix flake update` bumps them): `init -plugin-dir` turns off downloads from the
# registry, and the configuration asks for exactly the version nixpkgs has. There is no
# .terraform.lock.hcl to commit; flake.lock is the lock file.
{
  lib,
  system,
  terranix,
  writeShellApplication,
  opentofu,
  google-cloud-sdk,
  gh,
  coreutils,
  git,
}: let
  providers = p: [p.hashicorp_google];
  tofu = opentofu.withPlugins providers;
  pluginDir = "${tofu}/libexec/terraform-providers";
  settings = import ../infra/settings.nix;
  inherit (settings) project region stateBucket repository;
  config = terranix.lib.terranixConfiguration {
    inherit system;
    extraArgs = {inherit settings;};
    modules = [
      ../infra
      {
        terraform.backend.gcs = {
          bucket = stateBucket;
          prefix = "infra";
        };
        terraform.required_providers = builtins.listToAttrs (map (p: {
          name = builtins.baseNameOf p.provider-source-address;
          value.version = "= ${p.version}";
        }) (providers opentofu.plugins));
      }
    ];
  };
in
  writeShellApplication {
    name = "infra";
    runtimeInputs = [tofu google-cloud-sdk gh coreutils git];
    text = ''
      root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
      work="$root/infra/.work"
      mkdir -p "$work"
      install -m 644 ${config} "$work/config.tf.json"

      init() {
        # flake.lock pins the providers; a lock from before the last bump would refuse them.
        rm -f "$work/.terraform.lock.hcl"
        if ! tofu -chdir="$work" init -input=false -no-color -plugin-dir=${pluginDir} >"$work/init.log" 2>&1; then
          cat "$work/init.log" >&2
          exit 1
        fi
      }

      # CI sets it from the GCP_BILLING_ACCOUNT variable; locally, ask gcloud.
      billing_account() {
        if [ -z "''${TF_VAR_billing_account:-}" ]; then
          TF_VAR_billing_account="$(gcloud billing projects describe ${project} --format='value(billingAccountName)' | sed 's|^billingAccounts/||')"
          if [ -z "$TF_VAR_billing_account" ]; then
            echo "${project} has no billing account linked. Link one: https://console.cloud.google.com/billing/linkedaccount?project=${project}" >&2
            exit 1
          fi
          export TF_VAR_billing_account
        fi
      }

      # The repository variables and the `infra` environment that CI uses. Needs `gh auth login`
      # as an admin of the repository.
      github() {
        gh variable set GCP_BILLING_ACCOUNT --repo ${repository} --body "$TF_VAR_billing_account"
        gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo ${repository} \
          --body "$(tofu -chdir="$work" output -raw workload_identity_provider)"
        gh api --silent -X PUT repos/${repository}/environments/infra --input - <<'JSON'
      {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
      JSON
        if ! gh api repos/${repository}/environments/infra/deployment-branch-policies \
          --jq '.branch_policies[].name' | grep -qx main; then
          gh api --silent -X POST repos/${repository}/environments/infra/deployment-branch-policies \
            -f name=main -f type=branch
        fi
        echo "GitHub: variables set; the infra environment admits main only."
      }

      case "''${1:-}" in
        bootstrap)
          gcloud config set project ${project} >/dev/null
          # What the first plan needs before it can enable the rest itself.
          gcloud services enable --project ${project} \
            cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
            cloudbilling.googleapis.com billingbudgets.googleapis.com storage.googleapis.com
          billing_account
          if ! gcloud storage buckets describe gs://${stateBucket} >/dev/null 2>&1; then
            gcloud storage buckets create gs://${stateBucket} --project ${project} \
              --location ${region} --uniform-bucket-level-access --public-access-prevention
          fi
          init
          tofu -chdir="$work" apply
          github
          ;;
        github)
          billing_account
          init
          github
          ;;
        "")
          echo "usage: infra bootstrap | infra github | infra <tofu command> [args]" >&2
          exit 2
          ;;
        *)
          billing_account
          init
          exec tofu -chdir="$work" "$@"
          ;;
      esac
    '';
  }
