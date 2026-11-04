# The code executor: Python code blocks under nsjail (docs/architecture.md §2.14), and its package builder (§2.26,
# `--target builder`). Build from the repo root:
#   docker build -f apps/code-executor/Dockerfile -t ow-code-executor apps/code-executor
# Run with --cap-add SYS_ADMIN and the seccomp profile next to this file (docker-compose.yml does).

# nsjail isn't packaged by Debian: built from a pinned release (Apache-2.0).
FROM debian:bookworm-slim AS nsjail
RUN apt-get update && apt-get install -y --no-install-recommends \
      autoconf bison ca-certificates flex g++ gcc git libnl-route-3-dev libprotobuf-dev libtool make pkg-config \
      protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
ARG NSJAIL_VERSION=3.6
ARG NSJAIL_COMMIT=f78475530b46d0186111a9096b30725f816b55fe
RUN git clone --depth 1 --branch "$NSJAIL_VERSION" https://github.com/google/nsjail.git /nsjail \
 && cd /nsjail && test "$(git rev-parse HEAD)" = "$NSJAIL_COMMIT" \
 && make -j"$(nproc)" && strip nsjail

# The package builder (M23): `--target builder`. The same Python and platform as the executor below, so the wheels it
# installs fit the jail's interpreter; pip pinned. It runs as its own user and writes only /envs (a volume).
FROM python:3.12-slim-bookworm AS builder
COPY executor/builder-requirements.lock /opt/builder/requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes -r /opt/builder/requirements.lock \
 && useradd --uid 10001 --create-home builder && mkdir /envs && chown builder /envs
COPY executor/builder.py /opt/builder/
USER builder
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=UTC
EXPOSE 8080
VOLUME /envs
CMD ["python3", "-I", "/opt/builder/builder.py"]

# The executor (the default target).
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libnl-route-3-200 libprotobuf32 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=nsjail /nsjail/nsjail /usr/local/bin/nsjail
# The packages code can import, in their own virtualenv (the jail sees it read-only; the server doesn't use it).
COPY executor/requirements.lock /opt/executor/requirements.lock
# pip writes the bytecode as it installs (the jail can't: read-only), then leaves: code can't install anything anyway.
RUN python -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/executor/requirements.lock \
 && /opt/py/bin/pip uninstall -y -q pip
COPY executor/server.py executor/runner.py executor/jail.cfg executor/entrypoint.sh /opt/executor/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=UTC
EXPOSE 8080
ENTRYPOINT ["/opt/executor/entrypoint.sh"]
CMD ["python3", "-I", "/opt/executor/server.py"]
