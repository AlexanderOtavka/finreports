# Demo deployments (Google Cloud)

Everyone can try finreports on the sample data, without logging in: main's demo, and one per
pull request, on Cloud Run's free tier. Everything is declared here, as Terranix modules
that `nix run .#infra` renders and runs OpenTofu on, except for the Google account, the
billing account, and the `finreports-firefly` project itself (imported).

| File | |
|---|---|
| `settings.nix` | Project, region, repository, state bucket. |
| `project.nix` | The project (imported), its APIs, the state bucket (imported). |
| `ci.nix` | Workload Identity Federation for GitHub Actions, and its three service accounts. |
| `demo.nix` | The `finreports-demo` Cloud Run service, and Artifact Registry's cache of GHCR. |
| `killswitch.nix`, `killswitch.py` | The budget, and the service that unlinks billing on any charge. |

## How a demo gets there

CI (`.github/workflows/ci.yml`) builds the demo image (`nix/demo-container.nix`: the service
with `DEMO_MODE=true` and its own PostgreSQL in `/tmp`), pushes it to GHCR as
`demo-sha-<commit>`, and deploys it to `finreports-demo` through Artifact Registry's cache:

- **main**: a new revision, taking all of the service's traffic.
- **a pull request** from this repository: a revision with the tag `pr-<number>` and no
  traffic, at `https://pr-<number>---finreports-demo-….run.app/reports/`. The PR shows it
  as a deployment to `demo-pr`, with a "View deployment" button. `preview-cleanup.yml`
  removes the tag when the PR closes.

Each revision runs at most one instance, which keeps its database in memory: a demo starts
from the sample data whenever it wakes up, about 15 minutes after its last visit.

## Setup, once

From a checkout, with Nix:

```bash
nix develop -c gcloud auth login --update-adc   # you, as the project's owner
nix develop -c gh auth login                     # an admin of the repository, if not already
nix run .#infra -- bootstrap
```

`bootstrap` enables the APIs the first plan needs, checks the project has a billing account
linked (link one in the console otherwise), creates the state bucket, and runs
`tofu apply`: the plan imports the project and the bucket and creates the rest, and asks
before applying. Then it sets the repository variables `GCP_BILLING_ACCOUNT` and
`GCP_WORKLOAD_IDENTITY_PROVIDER`, and creates the `infra` environment that only `main` may
deploy to. Until those variables exist, CI skips everything that needs Google Cloud.

If an apply fails right after the APIs were enabled, they had not propagated yet: run
`nix run .#infra -- apply` again. `nix run .#infra -- github` repeats only the GitHub part.

## Changes

Edit the modules here. A pull request gets `tofu plan` in the summary of its Infra run, as
the read-only `infra-plan` account; main applies it as `infra-apply`, in the `infra`
environment. Locally, `nix run .#infra -- plan` (or any other `tofu` command) runs as you.

`infra-apply` owns the project, but on the billing account it can only manage budgets: it
cannot link billing, so no apply can undo the kill switch. For the same reason, changes to
the billing account's IAM (`google_billing_account_iam_member`) must be applied locally, by
a billing account administrator.

## The kill switch

The budget counts this project's cost net of the free tier, but not of trial or promotional
credit. Cloud Billing posts its state to Pub/Sub several times a day, and
`billing-killswitch` unlinks the project from its billing account as soon as the month's
cost is above zero. You also get emails at the first cent and at $1.

- Budget data lags usage by hours, so a few cents can be billed before it trips.
- Unlinking stops everything in the project, and Google may eventually delete what is in it,
  this configuration's state included. To recover, find out what cost money, fix it here,
  link billing again in the console, and run `nix run .#infra -- bootstrap` (it imports the
  project and the bucket again, if they are gone).
- It trips during a free trial too: a cost the trial credit covers today is one the card
  would pay once the credit runs out.

What should keep the bill at zero: one instance per revision, CPU only while serving a
request, the cache of GHCR emptied of anything older than a week (Artifact Registry's free
storage is 0.5 GB, a demo image about 110 MB), and the kill switch's image pulled straight
from Docker Hub.
