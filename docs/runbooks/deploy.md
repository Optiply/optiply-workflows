# Deploy: production on Google Cloud

Optiply Workflows in production: one small VM in the Google Cloud project **`optiply-workflows`**, running the
Docker Compose stack in `deploy/`. Set up in session 54 (2026-11-14).

**Budget: €5 a month at most.** Everything here is chosen for Google Cloud's free tier. Before adding or resizing
anything, check its price; the budget alert (step 2) warns at €5 but doesn't stop spending.

## What runs where

| Part | Where | Cost |
|---|---|---|
| The whole stack (app, Postgres, the runners, Caddy for HTTPS) | VM `ow-prod`, **e2-micro** (2 shared vCPUs, 1 GB), Debian 12, `us-east1-b`, 30 GB standard disk | Free tier (one e2-micro, 30 GB standard disk, US regions only) |
| Its public address | Static IP `ow-prod-ip` | Possibly ~$3.65 a month (Google's pages disagree whether the free tier covers it) |
| Images | Artifact Registry `us-east1-docker.pkg.dev/optiply-workflows/ow`, the last 3 versions kept (cleanup policy) | 0.5 GB free, then ~$0.10/GB a month. **A version (the 5 images) is ~0.8 GB**: builds share few layers, so even one version is over the free 0.5 GB. Two versions (current + rollback) ≈ 1.5 GB ≈ $0.10 a month; three ≈ $0.18 (2026-11-18) |
| Image builds | Cloud Build, default machine | 2,500 build-minutes a month free |
| Settings and secrets | Secret Manager: `ow-env` (the whole `.env`), `ow-db-readonly` (the read-only database user's password) | Free (up to 6 active versions) |
| Backups | Bucket `gs://optiply-workflows-backups` (`us-east1`), nightly `pg_dump`, deleted after 30 days | Free (5 GB in US regions) |
| Traffic | Out of the VM | 1 GB a month free from North America; then ~$0.12/GB. Caddy compresses. |

The stack is sized for 1 GB (`deploy/docker-compose.prod.yml`): the API and worker in one process (`ROLE=all`), no
Kafka, Postgres tuned small, Python, SDK and JDBC runners one job at a time, the JVM's heap at 128 MB. The VM has
compressed swap in memory (zram) and a 1 GB swap file (`deploy/vm-setup.sh`).

## First setup (once)

Run from the repo on a machine with `gcloud` signed in as a project owner. `P=optiply-workflows`.

1. **Services:** `gcloud services enable compute.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com iap.googleapis.com --project $P`
2. **Budget alert at €5** (Billing → Budgets & alerts, or `gcloud billing budgets create`): 50 %, 90 %, 100 %.
3. **Registry:** `gcloud artifacts repositories create ow --repository-format=docker --location=us-east1 --project $P`, with a cleanup policy keeping the 3 newest versions.
4. **Build the images:** `gcloud builds submit --project $P --region us-east1 --config deploy/cloudbuild.yaml --substitutions _TAG=$(git rev-parse --short HEAD) .` (uploads the source without `.env`: `.gcloudignore`).
5. **The VM's identity:** a service account `ow-vm-prod` (IDs need 6+ characters) with `roles/artifactregistry.reader`, `roles/secretmanager.secretAccessor` (on `ow-env`) and `roles/storage.objectCreator` and `roles/storage.objectViewer` (both on the backups bucket: `backup.sh` streams the dump, and a streamed upload also reads the object, so Creator alone fails with 403; neither can delete a backup), plus `roles/logging.logWriter`.
6. **Address and VM:** a static IP `ow-prod-ip` in `us-east1`; the VM `ow-prod` (`e2-micro`, `us-east1-b`, Debian 12, 30 GB **pd-standard**, service account `ow-vm-prod`, scope `cloud-platform`, tag `ow-prod`). Firewall (target tag `ow-prod`): `ow-allow-web` 80 and 443 from anywhere; `ow-allow-iap-ssh` 22 from IAP's range `35.235.240.0/20` (priority 800); `ow-deny-admin-ports` 22 and 3389 from anywhere (priority 900, over the default network's open SSH/RDP rules). SSH: `gcloud compute ssh ow-prod --zone us-east1-b --tunnel-through-iap`.
7. **The backups bucket:** `gs://optiply-workflows-backups` in `us-east1`, standard class, uniform access, lifecycle "delete after 30 days".
8. **Sign-in, Optiply's Auth0** (session 58, as the feedback app): the Auth0 application "Optiply Workflows" (single-page
   app, no client secret) allows `https://<SITE_ADDRESS>` as its callback and logout URL, so the sign-in comes back to
   the site's root (`OIDC_CALLBACK_PATH=/`; the server answers `/` with `code` and `state` before the web app) and
   signing out returns there. (Checked 2026-11-18: Auth0 answered 403 to `/api/auth/oidc/callback`, 302 to the root;
   `/v2/logout` refused `returnTo=…/login`.) In `ow-env`: `OIDC_ISSUER=https://optiply.eu.auth0.com/`,
   `OIDC_CLIENT_ID=<its client id>`, `OIDC_PROVIDER_NAME=Optiply`, `OIDC_CALLBACK_PATH=/`, and **no**
   `OIDC_CLIENT_SECRET` (with one, the code exchange sends it, and Auth0 refuses a secret for a public client).
   The rules stay the server's: a verified email, `@optiply.nl` or invited, an admin's approval the first time; people
   are matched by email, so existing accounts carry over. (Before: Google: Google Cloud console → APIs & Services →
   OAuth consent screen **Internal**; an OAuth client ID, Web application, redirect URI
   `https://<SITE_ADDRESS>/api/auth/oidc/callback`; `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, issuer the default.)
9. **The secret `ow-env`:** a `.env` with `PUBLIC_URL=https://<SITE_ADDRESS>`, `SITE_ADDRESS`, `SESSION_SECRET` (new), `ENCRYPTION_KEYS` and `ENCRYPTION_KEY_CURRENT` (**the same as the data's**: the resources' credentials are encrypted with them), the sign-in's `OIDC_*` (step 8), `OIDC_ALLOWED_DOMAIN=optiply.nl`, the four runner tokens and `METRICS_TOKEN` (new, random; without it `/metrics` is public), `GOOGLE_SERVER_IDENTITY` if used. `gcloud secrets create ow-env --data-file=… --replication-policy=user-managed --locations=us-east1`; delete the local file after.
10. **On the VM:** copy `deploy/*` and `apps/code-executor/seccomp.json` to `/opt/ow`, then `sudo bash /opt/ow/vm-setup.sh`.
11. **The data:** see "Moving the data" below. Then `sudo /opt/ow/deploy.sh <tag>`.
12. **Check:** `https://<SITE_ADDRESS>/api/health` gives 200; sign in with Google; approve colleagues in Settings → Users.

Until `workflows.optiply.nl` exists, `SITE_ADDRESS` is the IP as an sslip.io name, e.g. `34-75-1-2.sslip.io`.

## Moving the data

From the source stack: `docker compose exec -T postgres pg_dump -U ow -Fc optiply_workflows > ow.dump`. Copy it to
the VM (`gcloud compute scp --tunnel-through-iap`), then there: start only Postgres
(`docker compose -f docker-compose.prod.yml up -d postgres`), `pg_restore -U ow -d optiply_workflows --clean
--if-exists --no-owner < ow.dump`, and clear the run history (`truncate workflow_runs cascade` takes block runs, their
payloads and the run logs with it). Then `deploy.sh`. The encryption keys in `ow-env` must be the source's.

## Everyday

- **Deploy a version:** build it (step 4, tag = the commit's short hash), then on the VM `sudo /opt/ow/deploy.sh <tag>`.
  Migrations run by themselves (`migrate`).
- **Roll back:** `sudo /opt/ow/deploy.sh $(cat /opt/ow/.previous-tag)`. Migrations only add things, so an older image
  runs on the newer schema; for a migration that doesn't, restore the backup taken before.
- **After a deploy, keep only two versions** (the current tag and `.previous-tag`, for a rollback), in both places:
  - **The registry** (each version ~0.8 GB, billed past 0.5 GB): for each image (`app`, `code-executor`,
    `jdbc-runner`, `python-builder`, `sdk-runner`), `gcloud artifacts docker images list
    us-east1-docker.pkg.dev/$P/ow/<image> --include-tags`, then for an older tag `gcloud artifacts docker images delete
    us-east1-docker.pkg.dev/$P/ow/<image>@<digest> --delete-tags --quiet`. The cleanup policy alone keeps three.
  - **The VM's disk** (each version ~3.3 GB unpacked; `deploy.sh` only prunes images older than 7 days, so frequent
    deploys pile up): `sudo docker rmi us-east1-docker.pkg.dev/$P/ow/<image>:<old tag>` for each image and older tag.
    Not `docker image prune -a`: Postgres runs from an untagged image when `postgres:18` was pulled anew.
- **Logs:** `docker compose -f docker-compose.prod.yml logs --since 1h app`.
- **Memory:** `free -m`, `docker stats --no-stream`. Lots of swap in use means the VM is too small (see "Bigger").

## Automatic deploys (GitHub Actions)

**From `github.com/Optiply/optiply-workflows`** (since 2026-11-18; before, the personal repo, whose trust was
removed). **Once a day, weekdays at 18:00 Amsterdam time** (since 2026-11-19; before, every merge deployed),
`.github/workflows/deploy.yml` deploys the latest commit on `main` that passed CI, unless production already runs it
(`/opt/ow/.current-tag`): Cloud Build builds the images (tag = the commit's 7-character hash), `deploy/` is copied to
the VM, `deploy.sh <tag>` runs (migrations included), then `/api/health` must answer 200 within 3 minutes, or it rolls
back to `.previous-tag` and the run fails. Merging to `main` doesn't deploy: several merges a day go out together.

- **The schedule:** GitHub's cron is UTC, so it fires at 16:00 and 17:00 UTC; the run that isn't 18:00 in Amsterdam
  (summer +0200, winter +0100) stops at "Pick the commit". GitHub can start scheduled runs some minutes late. In a public
  repository GitHub switches schedules off after 60 days without activity (Actions → Deploy → Enable workflow).
- **By hand:** Actions → Deploy → Run workflow (on `main`), for an urgent fix or anything that can't wait for 18:00.
  Leave "tag" empty to build and deploy `main`'s head (it doesn't wait for CI: check it's green first); give an
  already-built tag (a short hash, or `s54a`) to deploy that version, e.g. to roll back. Only `main` can deploy.
- **Docs only:** changes only under `docs/` or to `*.md` files run no CI (`paths-ignore`), so they're never deployed.
  For a mixed change that still shouldn't rebuild, `[skip ci]` in the commit (and the merge commit's) message.
- **Pull requests:** a draft PR runs only `check` (lint, types, unit tests); e2e and the image builds run once it's
  marked ready for review, and on every push after that. A new push cancels the branch's older run. Usual rhythm: one
  branch and draft PR per working session, seen during the day on the local stack (`localhost:3000`) or `pnpm dev`,
  marked ready and merged at the end; it goes live at 18:00.
- **Old images:** the workflow doesn't remove them: keep two versions (see "Everyday").
- **Sign-in without a key:** Workload Identity pool `github`, provider `github-actions` (condition: repository
  `Optiply/optiply-workflows` and ref `refs/heads/main`), service account `gh-deployer` (workloadIdentityUser for that
  repository's principalSet only):
  `roles/cloudbuild.builds.editor` + `roles/serviceusage.serviceUsageConsumer` (project), `roles/storage.admin` on
  `gs://optiply-workflows_cloudbuild`, `roles/iam.serviceAccountUser` on the default compute SA (builds run as it) and on
  `ow-vm-prod`, `roles/compute.osAdminLogin` + `roles/compute.viewer` on `ow-prod`, `roles/iap.tunnelResourceAccessor`
  on the project with the condition `destination.port == 22` (Google refuses that role on a single VM), and the custom
  role `owProjectReader` (only `compute.projects.get`) on the project: `gcloud compute ssh` reads the project's metadata
  before it connects. Without it the deploy stops at "Copy deploy/ to the VM" (2026-11-15).
  ```bash
  gcloud iam roles create owProjectReader --project optiply-workflows \
    --title "OW: read the project (gcloud compute ssh)" --permissions compute.projects.get --stage GA
  gcloud projects add-iam-policy-binding optiply-workflows --condition=None \
    --member serviceAccount:gh-deployer@optiply-workflows.iam.gserviceaccount.com \
    --role projects/optiply-workflows/roles/owProjectReader
  ```
- **Flaky tests on `main`:** the daily deploy takes the latest *green* commit, so a red CI on `main` holds the newest
  merge back (an older green one may still go out). When the failure is a known flaky test and the same code passed on
  its PR, deploy by hand instead of re-running CI again and again.
- **Cost:** Cloud Build's free 2,500 minutes a month (~8 per deploy); GitHub's Actions minutes.
- **A failed run:** its log links the Cloud Build log; a failed health check has already rolled back. Fix on a branch,
  merge again.

## Looking at the data

- **In the app:** Settings → Users (people, groups, sign-in, last login), Settings → Audit log. The app's Database
  section holds the apps' own tables (`owdb_production`), not the app's internal ones.
- **A database app (TablePlus, DBeaver, pgAdmin), read-only:** Postgres listens on the VM's `127.0.0.1:5432` only.
  1. Tunnel, kept open in a terminal:
     `gcloud compute ssh ow-prod --zone us-east1-b --tunnel-through-iap --project optiply-workflows -- -N -L 5433:127.0.0.1:5432`
  2. Connect to `localhost:5433`, database `optiply_workflows`, user `ow_readonly`, password:
     `gcloud secrets versions access latest --secret=ow-db-readonly --project optiply-workflows`
  `ow_readonly` reads every table in `public`, `drizzle`, `owdb_production` and `owdb_staging` (default privileges cover
  tables created later), sessions are read-only (`default_transaction_read_only`), queries stop after 60 s, 5
  connections at most. Made in session 54 by hand (not a migration): roles aren't in `pg_dump`, so a restore onto a new
  server needs it again (`CREATE ROLE … LOGIN PASSWORD …`, `GRANT CONNECT`, per schema `GRANT USAGE`, `GRANT SELECT ON
  ALL TABLES`, `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> … GRANT SELECT ON TABLES`).
- **Ready-made queries:** `docs/runbooks/common-queries.sql` (people and access, workflows and runs, apps, resources,
  the audit log, sizes); all read-only, tested as `ow_readonly`.
- **SQL in a terminal (as the owner, can write: careful):**
  `gcloud compute ssh ow-prod --zone us-east1-b --tunnel-through-iap --project optiply-workflows -- sudo docker compose -f /opt/ow/docker-compose.prod.yml exec postgres psql -U ow optiply_workflows`

## Backups and restore

Nightly at 03:00 UTC to `gs://optiply-workflows-backups` (`deploy/backup.sh`; log `/var/log/ow-backup.log`). Restore:
`gcloud storage cp gs://optiply-workflows-backups/<file> -` into `pg_restore` as in "Moving the data". A dump is
useless without `ENCRYPTION_KEYS` (in `ow-env`), which is why they're kept apart. More: `backup.md`.

## Changes for later

- **The real domain (`workflows.optiply.nl`):** whoever runs optiply.nl's DNS adds an A record to `ow-prod-ip`. Then a
  new version of `ow-env` with the new `SITE_ADDRESS` and `PUBLIC_URL` (destroy the old version), the redirect URI
  added to the OAuth client, and `deploy.sh <current tag>`. Everyone signs in again; webhook URLs given out change.
- **Bigger (if 1 GB is too little):** stop the VM, `gcloud compute instances set-machine-type ow-prod
  --machine-type e2-small` (2 GB) or `e2-medium` (4 GB), start it. Not free: about €13 or €25 a month. Then raise
  `WORKER_CONCURRENCY`, `PYTHON_MAX_CONCURRENT`, `SDK_MAX_CONCURRENT`, `JDBC_HEAP_MB` in `ow-env`.
- **To Europe:** there's no free VM in Europe (an e2-micro there is ~€7 a month). A new VM in, say, `europe-west4`
  (steps 5–6, 10), a backup restored on it, the address moved (DNS, or a new sslip.io name), the old VM deleted.
  About an hour, a few minutes offline.
