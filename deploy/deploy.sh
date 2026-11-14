#!/usr/bin/env bash
# Deploys a version on the VM (docs/runbooks/deploy.md). Run as root in /opt/ow:
#   sudo /opt/ow/deploy.sh <image tag>        # e.g. the commit's short hash Cloud Build tagged
# Writes .env from Secret Manager (the secret `ow-env`: every setting and secret the stack reads), pulls the
# images, runs the migrations and recreates what changed. The previous tag is kept in .previous-tag for a rollback
# (`deploy.sh $(cat .previous-tag)`).
set -euo pipefail
cd /opt/ow

TAG=${1:?usage: deploy.sh <image tag>}
PROJECT=optiply-workflows
PREFIX=us-east1-docker.pkg.dev/$PROJECT/ow

umask 077
{
  gcloud secrets versions access latest --secret=ow-env --project="$PROJECT"
  echo
  echo "IMAGE_PREFIX=$PREFIX"
  echo "IMAGE_TAG=$TAG"
} >.env.new
mv .env.new .env

[ -f .current-tag ] && cp .current-tag .previous-tag
docker compose -f docker-compose.prod.yml pull --quiet
docker compose -f docker-compose.prod.yml up -d --remove-orphans
echo "$TAG" >.current-tag

# Old images go: the disk is small.
docker image prune -af --filter "until=168h" >/dev/null || true
docker compose -f docker-compose.prod.yml ps --format '{{.Service}}: {{.Status}}'
