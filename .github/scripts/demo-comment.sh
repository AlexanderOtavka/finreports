#!/usr/bin/env bash
# demo-comment.sh <pr> <markdown>: the PR's one demo comment, posted by CI and edited on every
# deploy and when the PR closes (ci.yml, preview-cleanup.yml). Needs GH_TOKEN and GH_REPO.
set -euo pipefail
pr="$1"
marker="<!-- finreports-demo -->"
body="${marker}
$2"
id="$(gh api "repos/${GH_REPO}/issues/${pr}/comments" --paginate \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"${marker}\"))) | .id" |
  head -n1)"
if [ -n "$id" ]; then
  gh api --silent -X PATCH "repos/${GH_REPO}/issues/comments/${id}" -f body="$body"
else
  gh api --silent -X POST "repos/${GH_REPO}/issues/${pr}/comments" -f body="$body"
fi
