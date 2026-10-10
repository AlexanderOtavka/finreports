# The Google Cloud side of the demo deployments, as Terranix modules: `nix run .#infra --
# plan` renders them to config.tf.json and runs OpenTofu on it. See infra/README.md.
{
  imports = [
    ./project.nix
    ./ci.nix
    ./demo.nix
    ./killswitch.nix
  ];
}
