# The demo service. Main's demo serves its traffic; each pull request's demo is a revision
# with a tag and no traffic, at https://pr-<n>---finreports-demo-….run.app/reports/. CI
# deploys both (.github/workflows/ci.yml, preview-cleanup.yml); this file sets up the rest.
{settings, ...}: let
  inherit (settings) project region;
in {
  # Cloud Run pulls from Artifact Registry, not from GHCR, so a remote repository fronts
  # GHCR: ${region}-docker.pkg.dev/${project}/ghcr/alexanderotavka/finreports:<tag>.
  resource.google_artifact_registry_repository.ghcr = {
    location = region;
    repository_id = "ghcr";
    description = "Pull-through cache of ghcr.io";
    format = "DOCKER";
    mode = "REMOTE_REPOSITORY";
    remote_repository_config = {
      description = "ghcr.io";
      docker_repository.custom_repository.uri = "https://ghcr.io";
    };
    # The cache is all that is stored, and it stays under the free 0.5 GB: anything not
    # pulled for a week goes, and is fetched from GHCR again if it is ever needed.
    cleanup_policy_dry_run = false;
    cleanup_policies = [
      {
        id = "drop-week-old";
        action = "DELETE";
        condition.older_than = "604800s";
      }
    ];
    depends_on = ["google_project_service.artifactregistry"];
  };

  # The demo runs as an account with no roles at all.
  resource.google_service_account.demo = {
    account_id = "finreports-demo";
    display_name = "finreports demo (no roles)";
    depends_on = ["google_project_service.iam"];
  };

  resource.google_cloud_run_v2_service.demo = {
    name = "finreports-demo";
    location = region;
    ingress = "INGRESS_TRAFFIC_ALL";
    deletion_protection = false;
    template = {
      service_account = "\${google_service_account.demo.email}";
      # The full Linux environment: PostgreSQL in the container wants real shared memory
      # and signals.
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2";
      # One instance per revision: its database is in its memory, so a second instance
      # would be a second demo. Also caps what a revision can cost.
      scaling = {
        min_instance_count = 0;
        max_instance_count = 1;
      };
      max_instance_request_concurrency = 80;
      containers = [
        {
          # A stand-in until CI deploys the demo image; CI owns the image from then on.
          image = "us-docker.pkg.dev/cloudrun/container/hello";
          ports.container_port = 8080;
          resources = {
            limits = {
              cpu = "1";
              # PostgreSQL's data lives in memory too (/tmp).
              memory = "1Gi";
            };
            # CPU only while serving a request: billed per request, inside the free tier.
            cpu_idle = true;
            startup_cpu_boost = true;
          };
          startup_probe = {
            tcp_socket.port = 8080;
            period_seconds = 2;
            failure_threshold = 60;
          };
        }
      ];
    };
    lifecycle.ignore_changes = [
      "template[0].containers[0].image"
      "template[0].revision"
      "traffic"
      "client"
      "client_version"
    ];
    depends_on = ["google_project_service.run"];
  };

  # Anyone may look: the demo has only generated data.
  resource.google_cloud_run_v2_service_iam_member = {
    demo-public = {
      name = "\${google_cloud_run_v2_service.demo.name}";
      location = region;
      role = "roles/run.invoker";
      member = "allUsers";
    };
    demo-deployer = {
      name = "\${google_cloud_run_v2_service.demo.name}";
      location = region;
      role = "roles/run.developer";
      member = "serviceAccount:\${google_service_account.preview-deployer.email}";
    };
  };

  # Deploying a revision that runs as the demo account needs this on that account.
  resource.google_service_account_iam_member.preview-deployer-acts-as-demo = {
    service_account_id = "\${google_service_account.demo.name}";
    role = "roles/iam.serviceAccountUser";
    member = "serviceAccount:\${google_service_account.preview-deployer.email}";
  };

  output = {
    demo_url.value = "\${google_cloud_run_v2_service.demo.uri}/reports/";
    demo_image_repository.value = "${region}-docker.pkg.dev/${project}/ghcr/alexanderotavka/finreports";
  };
}
