# GitHub Actions signs in with its OIDC token (no keys anywhere), as one of three service
# accounts:
#
# - infra-apply: runs `tofu apply` from main, in the `infra` environment only. Owner of the
#   project, and can manage the budget, but cannot link billing.
# - infra-plan: read-only, runs `tofu plan` on pull requests.
# - preview-deployer: deploys revisions of the demo service (demo.nix), from any workflow
#   of this repository.
{settings, ...}: let
  inherit (settings) project repository repositoryId;
  pool = "\${google_iam_workload_identity_pool.github.name}";
  wholeRepository = "principalSet://iam.googleapis.com/${pool}/attribute.repository_id/${repositoryId}";
  serviceAccount = name: description: {
    account_id = name;
    display_name = description;
    depends_on = ["google_project_service.iam"];
  };
  projectRole = account: role: {
    inherit project role;
    member = "serviceAccount:\${google_service_account.${account}.email}";
  };
in {
  resource.google_iam_workload_identity_pool.github = {
    workload_identity_pool_id = "github";
    display_name = "GitHub Actions";
    depends_on = ["google_project_service.iam" "google_project_service.sts"];
  };

  resource.google_iam_workload_identity_pool_provider.github = {
    workload_identity_pool_id = "\${google_iam_workload_identity_pool.github.workload_identity_pool_id}";
    workload_identity_pool_provider_id = "github";
    display_name = "GitHub Actions";
    oidc.issuer_uri = "https://token.actions.githubusercontent.com";
    attribute_mapping = {
      "google.subject" = "assertion.sub";
      "attribute.repository_id" = "assertion.repository_id";
    };
    # No other repository's token gets in at all.
    attribute_condition = "assertion.repository_id == '${repositoryId}'";
  };

  resource.google_service_account = {
    infra-apply = serviceAccount "infra-apply" "OpenTofu apply, from main (GitHub Actions)";
    infra-plan = serviceAccount "infra-plan" "OpenTofu plan, read-only (GitHub Actions)";
    preview-deployer = serviceAccount "preview-deployer" "Deploys demo revisions (GitHub Actions)";
  };

  resource.google_service_account_iam_member = {
    # The subject of a job in the `infra` environment, which only main may use.
    infra-apply = {
      service_account_id = "\${google_service_account.infra-apply.name}";
      role = "roles/iam.workloadIdentityUser";
      member = "principal://iam.googleapis.com/${pool}/subject/repo:${repository}:environment:infra";
    };
    infra-plan = {
      service_account_id = "\${google_service_account.infra-plan.name}";
      role = "roles/iam.workloadIdentityUser";
      member = wholeRepository;
    };
    preview-deployer = {
      service_account_id = "\${google_service_account.preview-deployer.name}";
      role = "roles/iam.workloadIdentityUser";
      member = wholeRepository;
    };
  };

  resource.google_project_iam_member = {
    infra-apply-owner = projectRole "infra-apply" "roles/owner";
    infra-plan-viewer = projectRole "infra-plan" "roles/viewer";
    infra-plan-iam = projectRole "infra-plan" "roles/iam.securityReviewer";
    # Calls bill their quota to the project (provider.google.user_project_override).
    infra-plan-quota = projectRole "infra-plan" "roles/serviceusage.serviceUsageConsumer";
  };

  resource.google_storage_bucket_iam_member.infra-plan-state = {
    bucket = "\${google_storage_bucket.state.name}";
    role = "roles/storage.objectViewer";
    member = "serviceAccount:\${google_service_account.infra-plan.email}";
  };

  # The budget (killswitch.nix) lives on the billing account. Costs Manager can change
  # budgets but not link projects to the account, so the apply can never re-enable billing.
  resource.google_billing_account_iam_member = {
    infra-apply = {
      billing_account_id = "\${var.billing_account}";
      role = "roles/billing.costsManager";
      member = "serviceAccount:\${google_service_account.infra-apply.email}";
    };
    infra-plan = {
      billing_account_id = "\${var.billing_account}";
      role = "roles/billing.viewer";
      member = "serviceAccount:\${google_service_account.infra-plan.email}";
    };
  };

  output = {
    workload_identity_provider.value = "\${google_iam_workload_identity_pool_provider.github.name}";
    infra_apply_service_account.value = "\${google_service_account.infra-apply.email}";
    infra_plan_service_account.value = "\${google_service_account.infra-plan.email}";
    preview_deployer_service_account.value = "\${google_service_account.preview-deployer.email}";
  };
}
