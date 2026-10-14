# One image, many roles: ROLE=api | worker | migrate (see docker-compose.yml).
# Debian (glibc) rather than Alpine because isolated-vm ships/compiles a native addon against glibc.

FROM node:24-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ow/web build && pnpm --filter @ow/server build
# Production node_modules for the server's external npm dependencies (incl. native addons).
RUN pnpm --filter @ow/server deploy --prod --legacy /out
# isolated-vm is compiled from patched source (patches/): keep the addon, drop the ~80 MB of build intermediates.
RUN find /out/node_modules/.pnpm -path '*/isolated-vm/build/*' -type f ! -name 'isolated_vm.node' -delete

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    TZ=UTC \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
COPY --from=build /repo/packages/db/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "--no-node-snapshot", "--enable-source-maps", "dist/main.js"]
