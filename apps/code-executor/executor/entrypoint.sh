#!/bin/sh
# Delegates cgroup v2 controllers so nsjail can give each jail its own memory, PID and CPU limits: Docker mounts
# the container's cgroup read-only, and a cgroup holding processes can't hand controllers down.
set -eu
cg=/sys/fs/cgroup
if ! touch "$cg/.rw" 2>/dev/null; then mount -o remount,rw "$cg"; fi
rm -f "$cg/.rw"
mkdir -p "$cg/executor"
for pid in $(cat "$cg/cgroup.procs"); do echo "$pid" > "$cg/executor/cgroup.procs" 2>/dev/null || true; done
echo "+memory +pids +cpu" > "$cg/cgroup.subtree_control"
exec "$@"
