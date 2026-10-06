{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeWrapper,
  nodejs_22,
}: let
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.server.json
      ../vite.config.ts
      ../vitest.config.ts
      ../migrations
      ../scripts
      ../src
      ../test
    ];
  };
in
  buildNpmPackage {
    pname = "finreports";
    version = (lib.importJSON ../package.json).version;
    inherit src;
    nodejs = nodejs_22;

    # Dependencies come straight from package-lock.json, so there is no npmDepsHash to
    # keep in step with it: updating the lockfile is the whole dependency update.
    npmDeps = importNpmLock {npmRoot = src;};
    npmConfigHook = importNpmLock.npmConfigHook;

    nativeBuildInputs = [makeWrapper];

    # `npm run build`: the web app into dist/web, the server into dist/server.
    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --no-audit --no-fund
      app=$out/lib/finreports
      mkdir -p $app
      cp -r package.json node_modules dist migrations $app/
      makeWrapper ${lib.getExe nodejs_22} $out/bin/finreports \
        --add-flags $app/dist/server/server/main.js
      runHook postInstall
    '';

    passthru = {inherit src;};

    meta = {
      description = "Interactive finance reports with recategorizing, merchant rules and a decision log";
      homepage = "https://github.com/AlexanderOtavka/finreports";
      license = lib.licenses.mit;
      mainProgram = "finreports";
    };
  }
