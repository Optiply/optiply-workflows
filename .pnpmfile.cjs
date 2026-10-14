// pnpm hooks (https://pnpm.io/pnpmfile).
module.exports = {
  hooks: {
    readPackage(pkg) {
      // drizzle-orm lists mysql2 as an optional peer for its MySQL driver, which we don't use (the platform
      // database is Postgres; mysql2 is only the MySQL connector's client). Left in, the server, which depends on
      // mysql2, gets its own drizzle-orm instance whose types don't match @ow/db's.
      if (pkg.name === 'drizzle-orm') {
        delete pkg.peerDependencies?.mysql2
        delete pkg.peerDependenciesMeta?.mysql2
      }
      return pkg
    },
  },
}
