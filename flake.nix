{
  description = "finreports: interactive, phone-first finance reports on top of Firefly III";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAllSystems (pkgs: let
      finreports = pkgs.callPackage ./nix/package.nix {};
    in
      {
        inherit finreports;
        default = finreports;
      }
      // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        container = pkgs.callPackage ./nix/container.nix {inherit finreports;};
      });

    checks = forAllSystems (pkgs: let
      inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) finreports;
      checks = pkgs.callPackage ./nix/checks.nix {inherit finreports;};
    in
      {
        inherit finreports;
        inherit (checks) tests;
      }
      // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        inherit (checks) smoke;
        inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) container;
      });

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages =
          [pkgs.nodejs_22 pkgs.postgresql_17]
          ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.chromium;
      };
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);
  };
}
