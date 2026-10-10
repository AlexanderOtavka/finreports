{
  description = "finreports: interactive, phone-first finance reports on top of Firefly III";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    terranix = {
      url = "github:terranix/terranix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    terranix,
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
        infra = pkgs.callPackage ./nix/infra.nix {
          inherit terranix;
          inherit (pkgs.stdenv.hostPlatform) system;
        };
      }
      // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        container = pkgs.callPackage ./nix/container.nix {inherit finreports;};
        demo-container = pkgs.callPackage ./nix/demo-container.nix {inherit finreports;};
      });

    apps = forAllSystems (pkgs: {
      infra = {
        type = "app";
        program = pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.infra;
        meta.description = "OpenTofu on infra/ (Terranix): bootstrap, plan, apply, …";
      };
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
        inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) container demo-container;
      });

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages =
          [pkgs.nodejs_22 pkgs.postgresql_17 pkgs.google-cloud-sdk]
          ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.chromium;
      };
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);
  };
}
