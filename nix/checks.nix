{
  lib,
  stdenv,
  chromium,
  fontconfig,
  dejavu_fonts,
  makeFontsConf,
  postgresql_17,
  finreports,
}: let
  # Reuses the package's dependencies and build; only the check and output differ.
  check = name: attrs:
    finreports.overrideAttrs (old:
      {
        pname = "finreports-${name}";
        nativeBuildInputs = old.nativeBuildInputs ++ [postgresql_17];
        doCheck = true;
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          runHook postInstall
        '';
      }
      // attrs);
in
  {
    # Typecheck and the unit tests, each test file against a throwaway PostgreSQL.
    tests = check "tests" {
      checkPhase = ''
        runHook preCheck
        npm run typecheck
        npm test
        runHook postCheck
      '';
    };
  }
  // lib.optionalAttrs stdenv.hostPlatform.isLinux {
    # The real server on the sample data, driven through the UI by headless Chromium at a
    # phone and a desktop viewport. The screenshots of every step are the output.
    smoke = check "smoke" {
      FONTCONFIG_FILE = makeFontsConf {fontDirectories = [dejavu_fonts];};
      checkPhase = ''
        runHook preCheck
        export HOME=$TMPDIR
        CHROMIUM_PATH=${lib.getExe chromium} node scripts/smoke.mjs
        runHook postCheck
      '';
      installPhase = ''
        runHook preInstall
        cp -r smoke-output $out
        runHook postInstall
      '';
    };
  }
