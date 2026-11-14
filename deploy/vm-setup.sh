#!/usr/bin/env bash
# One-time setup of the production VM (Debian 12, Google Cloud's e2-micro; docs/runbooks/deploy.md). Run as root:
#   sudo bash /opt/ow/vm-setup.sh
# Installs Docker with Compose, makes the 1 GB of memory go further (compressed swap in memory, a small swap file
# behind it), lets Docker pull from Artifact Registry with the VM's service account, and schedules the nightly
# backup. Safe to run again.
set -euo pipefail

REGISTRY_HOST=us-east1-docker.pkg.dev

# Docker Engine and the Compose plugin, from Docker's own packages (Debian's Compose is too old for this file).
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
# Containers' logs: kept small (the disk is 30 GB and the free tier doesn't cover more).
cat >/etc/docker/daemon.json <<'EOF'
{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl restart docker

# Memory: zram (compressed swap in memory, fast) first, then a 1 GB swap file on disk (slow, a last resort).
apt-get install -y zram-tools
cat >/etc/default/zramswap <<'EOF'
ALGO=zstd
PERCENT=60
PRIORITY=100
EOF
systemctl restart zramswap
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show | grep -q /swapfile || swapon --priority 10 /swapfile
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw,pri=10 0 0' >>/etc/fstab
cat >/etc/sysctl.d/90-ow.conf <<'EOF'
vm.swappiness=100
vm.page-cluster=0
EOF
sysctl --system >/dev/null

# Docker pulls from Artifact Registry as the VM's service account (gcloud is on Google's Debian images).
gcloud auth configure-docker "$REGISTRY_HOST" --quiet

# The nightly backup at 03:00 UTC (deploy/backup.sh).
cat >/etc/cron.d/ow-backup <<'EOF'
0 3 * * * root /opt/ow/backup.sh >>/var/log/ow-backup.log 2>&1
EOF

echo "VM ready: docker $(docker --version | cut -d' ' -f3) compose $(docker compose version --short)"
free -m
