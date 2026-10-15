# `nix run .#demo -- deploy <digest> [--pr <number>]` and `demo untag <number>`: what CI does
# to the demo service (infra/demo.nix), with the project, region and image from
# infra/settings.nix. `deploy` prints the demo's URL; everything else goes to stderr.
#
# - main: a revision tagged `main`, which then takes the traffic, by the tag (a PR may deploy
#   a later revision meanwhile).
# - a PR: a revision tagged `pr-<number>`, with no traffic, at its own URL.
# - untag: the PR's tag goes, and with it the URL; the revision stays, serving nothing.
{
  writeShellApplication,
  google-cloud-sdk,
  jq,
  coreutils,
}: let
  settings = import ../infra/settings.nix;
  inherit (settings) project region demoService demoImage;
in
  writeShellApplication {
    name = "demo";
    runtimeInputs = [google-cloud-sdk jq coreutils];
    text = ''
      service=(${demoService} --project ${project} --region ${region} --quiet)

      usage() {
        echo "usage: demo deploy sha256:<digest> [--pr <number>] | demo untag <number>" >&2
        exit 2
      }

      # Two deploys at once (two PRs) can conflict on the service; the loser retries.
      retry() {
        local delay="''${DEMO_RETRY_SECONDS:-15}"
        for i in 1 2 3 4; do
          "$@" && return
          sleep $((i * delay))
        done
        "$@"
      }

      # The tag's URL, from the service's traffic.
      tag_url() {
        gcloud run services describe "''${service[@]}" --format=json |
          jq -r --arg tag "$1" '.status.traffic[]? | select(.tag == $tag) | .url'
      }

      case "''${1:-}" in
        deploy)
          digest="''${2:-}"
          [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || usage
          pr=""
          if [ "$#" -gt 2 ]; then
            if [ "$#" -ne 4 ] || [ "$3" != --pr ] || ! [[ "$4" =~ ^[0-9]+$ ]]; then usage; fi
            pr="$4"
          elif [ "$#" -ne 2 ]; then
            usage
          fi
          image="${demoImage}@$digest"
          if [ -n "$pr" ]; then
            retry gcloud run deploy "''${service[@]}" --image "$image" --tag "pr-$pr" --no-traffic >&2
            url="$(tag_url "pr-$pr")"
          else
            retry gcloud run deploy "''${service[@]}" --image "$image" --tag main --no-traffic >&2
            retry gcloud run services update-traffic "''${service[@]}" --to-tags main=100 >&2
            url="$(gcloud run services describe "''${service[@]}" --format='value(status.url)')"
          fi
          if [ -z "$url" ]; then
            echo "deployed, but found no URL for it" >&2
            exit 1
          fi
          echo "$url/reports/"
          ;;
        untag)
          if [ "$#" -ne 2 ] || ! [[ "$2" =~ ^[0-9]+$ ]]; then usage; fi
          if [ -n "$(tag_url "pr-$2")" ]; then
            gcloud run services update-traffic "''${service[@]}" --remove-tags "pr-$2" >&2
          else
            echo "No pr-$2 demo." >&2
          fi
          ;;
        *) usage ;;
      esac
    '';
  }
