# Shared by the Terranix modules (as the `settings` argument) and nix/infra.nix.
{
  project = "finreports-firefly";
  # Tier 1 Cloud Run pricing, and a region where Cloud Storage's free tier applies.
  region = "us-central1";
  repository = "AlexanderOtavka/finreports";
  # GitHub's numeric id survives renames and cannot be claimed by another repository.
  repositoryId = "1406588301";
  stateBucket = "finreports-firefly-tofu-state";
}
