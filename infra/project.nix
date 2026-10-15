# The project (created by hand, imported here), its APIs, and the bucket that holds this
# configuration's state.
{settings, ...}: let
  inherit (settings) project region stateBucket;
in {
  terraform.required_providers.google.source = "hashicorp/google";

  provider.google = {
    inherit project region;
    # Bill API quota to this project, also when running as a person: the budgets API
    # refuses user credentials without a quota project.
    billing_project = project;
    user_project_override = true;
  };

  # The billing account the budget watches. Not a secret, but kept out of a public repo:
  # the GCP_BILLING_ACCOUNT repository variable in CI, read by `infra bootstrap` locally.
  variable.billing_account = {
    type = "string";
    description = "Billing account ID, like 012345-6789AB-CDEF01";
  };

  import = [
    {
      to = "google_project.finreports";
      id = project;
    }
    {
      to = "google_storage_bucket.state";
      id = stateBucket;
    }
  ];

  resource.google_project.finreports = {
    project_id = project;
    name = project;
    deletion_policy = "PREVENT";
    lifecycle.ignore_changes = [
      "name"
      "org_id"
      "folder_id"
      "auto_create_network"
      "labels"
      # Linked by hand, and unlinked by the kill switch (killswitch.nix). Never relinked by
      # an apply: that would undo the kill switch.
      "billing_account"
    ];
  };

  resource.google_project_service = builtins.listToAttrs (map (api: {
      name = builtins.head (builtins.split "\\." api);
      value = {
        service = "${api}.googleapis.com";
        disable_on_destroy = false;
      };
    }) [
      "artifactregistry"
      "billingbudgets"
      "cloudbilling"
      "cloudresourcemanager"
      "iam"
      "iamcredentials"
      "pubsub"
      "run"
      "serviceusage"
      "storage"
      "sts"
    ]);

  # Created by `infra bootstrap` before there was anywhere to keep state, then imported.
  resource.google_storage_bucket.state = {
    name = stateBucket;
    location = region;
    storage_class = "STANDARD";
    uniform_bucket_level_access = true;
    public_access_prevention = "enforced";
    versioning.enabled = true;
    # Keep the last 20 versions of the state.
    lifecycle_rule = [
      {
        condition = {
          num_newer_versions = 20;
          with_state = "ARCHIVED";
        };
        action.type = "Delete";
      }
    ];
    lifecycle.prevent_destroy = true;
  };

  output.project_number.value = "\${google_project.finreports.number}";
}
