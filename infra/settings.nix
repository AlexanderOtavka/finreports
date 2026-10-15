# Shared by the Terranix modules (as the `settings` argument), nix/infra.nix and nix/demo.nix.
rec {
  project = "finreports-firefly";
  # Oregon: the closest region to Washington, which has none, and one of the three where
  # Cloud Storage's free tier applies (with us-central1 and us-east1).
  region = "us-west1";
  repository = "AlexanderOtavka/finreports";
  # GitHub's numeric id survives renames and cannot be claimed by another repository.
  repositoryId = "1406588301";
  # The owner's (AlexanderOtavka's) id, for the OIDC subject (infra/ci.nix).
  ownerId = "8042691";
  stateBucket = "finreports-firefly-tofu-state";
  # The demo's Cloud Run service (infra/demo.nix), and its image, pulled from GHCR through
  # Artifact Registry's cache of it.
  demoService = "finreports-demo";
  demoImage = "${region}-docker.pkg.dev/${project}/ghcr/alexanderotavka/finreports";
}
