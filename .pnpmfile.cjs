// pnpm hooks (https://pnpm.io/pnpmfile).
module.exports = {
  hooks: {
    readPackage(pkg) {
      // drizzle-orm lists every driver and tracer it can work with (mysql2, @opentelemetry/api, …) as optional peers.
      // We only use its Postgres side. Left in, any workspace package that depends on one of them (the server on
      // mysql2 for the MySQL connector, on prom-client and so @opentelemetry/api for metrics) gets its own
      // drizzle-orm instance, whose types don't match @ow/db's. Keep only the Postgres drivers.
      if (pkg.name === 'drizzle-orm') {
        const keep = new Set(['postgres', 'pg'])
        for (const name of Object.keys(pkg.peerDependenciesMeta ?? {})) {
          if (keep.has(name) || !pkg.peerDependenciesMeta[name]?.optional) continue
          delete pkg.peerDependencies?.[name]
          delete pkg.peerDependenciesMeta[name]
        }
      }
      return pkg
    },
  },
}
