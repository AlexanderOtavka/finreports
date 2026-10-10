# The kill switch: a budget on this project that counts the free tier but not trial or
# promotional credit, and unlinks billing from the project as soon as the month's cost is
# above zero, i.e. as soon as anything would be charged.
#
# Unlinking stops every service in the project, free tier included, and Google may delete
# the project's resources (the demo, the image cache, this configuration's state bucket)
# if billing stays off. Nothing here is precious: re-link billing by hand, and run
# `infra bootstrap` again if the state is gone. Budget data lags usage by hours, so a few
# cents can still be billed before the switch trips.
{settings, ...}: let
  inherit (settings) project region;
in {
  resource.google_pubsub_topic.budget = {
    name = "billing-budget";
    depends_on = ["google_project_service.pubsub"];
  };

  # Cloud Billing publishes as this Google-owned account.
  resource.google_pubsub_topic_iam_member.budget-publisher = {
    topic = "\${google_pubsub_topic.budget.id}";
    role = "roles/pubsub.publisher";
    member = "serviceAccount:billing-budget-alert@system.gserviceaccount.com";
  };

  resource.google_billing_budget.cap = {
    billing_account = "\${var.billing_account}";
    display_name = "finreports: unlink billing on any charge";
    budget_filter = {
      projects = ["projects/\${google_project.finreports.number}"];
      calendar_period = "MONTH";
      # Net of the free tier and discounts, but not of trial or promotional credit: a cost
      # that a credit would cover today is one the card would pay once it runs out.
      credit_types_treatment = "INCLUDE_SPECIFIED_CREDITS";
      credit_types = [
        "FREE_TIER"
        "DISCOUNT"
        "SUSTAINED_USAGE_DISCOUNT"
        "COMMITTED_USAGE_DISCOUNT"
        "COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE"
        "SUBSCRIPTION_BENEFIT"
      ];
    };
    # The amount only scales the email thresholds; the kill switch looks at the cost.
    amount.specified_amount.units = "1";
    # Emails to the billing account's admins: at the first cent, and at the amount.
    threshold_rules = [
      {threshold_percent = 0.01;}
      {threshold_percent = 1.0;}
    ];
    all_updates_rule = {
      pubsub_topic = "\${google_pubsub_topic.budget.id}";
      schema_version = "1.0";
    };
    depends_on = ["google_project_service.billingbudgets" "google_pubsub_topic_iam_member.budget-publisher"];
  };

  # Runs the kill switch; may change only this project's billing link.
  resource.google_service_account.killswitch = {
    account_id = "billing-killswitch";
    display_name = "Unlinks billing on any charge";
    depends_on = ["google_project_service.iam"];
  };
  resource.google_project_iam_member.killswitch-unlink = {
    inherit project;
    role = "roles/billing.projectManager";
    member = "serviceAccount:\${google_service_account.killswitch.email}";
  };

  # Pub/Sub pushes as this account, the only one allowed to call the kill switch.
  resource.google_service_account.killswitch-push = {
    account_id = "billing-killswitch-push";
    display_name = "Pub/Sub push to the billing kill switch";
    depends_on = ["google_project_service.iam"];
  };

  # The stock Python image straight from Docker Hub, which Cloud Run pulls from directly:
  # no build, and nothing stored in the project that could cost anything.
  resource.google_cloud_run_v2_service.killswitch = {
    name = "billing-killswitch";
    location = region;
    ingress = "INGRESS_TRAFFIC_ALL";
    deletion_protection = false;
    template = {
      service_account = "\${google_service_account.killswitch.email}";
      scaling.max_instance_count = 1;
      containers = [
        {
          image = "docker.io/library/python:3.13-alpine";
          command = ["python3" "-c" (builtins.readFile ./killswitch.py)];
          env = [
            {
              name = "PROJECT_ID";
              value = project;
            }
          ];
          resources = {
            limits = {
              cpu = "1";
              memory = "256Mi";
            };
            cpu_idle = true;
          };
        }
      ];
    };
    depends_on = ["google_project_service.run"];
  };

  resource.google_cloud_run_v2_service_iam_member.killswitch-push = {
    name = "\${google_cloud_run_v2_service.killswitch.name}";
    location = region;
    role = "roles/run.invoker";
    member = "serviceAccount:\${google_service_account.killswitch-push.email}";
  };

  resource.google_pubsub_subscription.killswitch = {
    name = "billing-killswitch";
    topic = "\${google_pubsub_topic.budget.id}";
    ack_deadline_seconds = 60;
    expiration_policy.ttl = "";
    retry_policy = {
      minimum_backoff = "10s";
      maximum_backoff = "600s";
    };
    push_config = {
      push_endpoint = "\${google_cloud_run_v2_service.killswitch.uri}";
      oidc_token.service_account_email = "\${google_service_account.killswitch-push.email}";
    };
    depends_on = ["google_cloud_run_v2_service_iam_member.killswitch-push"];
  };
}
