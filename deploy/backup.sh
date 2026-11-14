#!/usr/bin/env bash
# The nightly database backup (cron, deploy/vm-setup.sh; docs/runbooks/deploy.md and backup.md): a pg_dump to the
# bucket gs://optiply-workflows-backups, which deletes dumps after 30 days. The encryption keys are NOT in it: they
# live in Secret Manager (`ow-env`), apart from the backups on purpose.
set -euo pipefail
cd /opt/ow
STAMP=$(date -u +%Y-%m-%dT%H%M)
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U ow -Fc optiply_workflows \
  | gcloud storage cp - "gs://optiply-workflows-backups/ow-$STAMP.dump"
echo "$(date -u) backup ow-$STAMP.dump done"
