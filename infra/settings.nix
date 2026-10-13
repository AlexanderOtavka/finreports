# Shared by the Terranix modules (as the `settings` argument) and nix/infra.nix.
{
  project = "finreports-firefly";
  # Oregon: the closest region to Washington, which has none, and one of the three where
  # Cloud Storage's free tier applies (with us-central1 and us-east1). Also in the
  # workflows' GCP_REGION.
  region = "us-west1";
  repository = "AlexanderOtavka/finreports";
  # GitHub's numeric id survives renames and cannot be claimed by another repository.
  repositoryId = "1406588301";
  stateBucket = "finreports-firefly-tofu-state";
}
