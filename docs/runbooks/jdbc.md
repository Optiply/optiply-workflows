# Runbook: JDBC resources

A JDBC resource (M38, `docs/architecture.md` §2.42) queries a database Node has no driver for: **Oracle, Snowflake and
ClickHouse** are built in, and an admin can upload any other driver jar (DB2, Exasol, SAP HANA, Teradata, Databricks…).
Queries run in the **JDBC runner**, a small Java service; the app sends each query with its connection's settings.

## The service

| Service | What it does | Network |
|---|---|---|
| `jdbc-runner` | Runs queries and connection tests with the drivers; keeps a connection pool per resource and app process; unpacks Oracle wallets into `/tmp` (memory); keeps uploaded jars in the `jdbc-drivers` volume. Read-only root. | `executor` (the app reaches it) + `jdbc-egress` (the databases) |

Settings (`.env`):

- `JDBC_RUNNER_TOKEN`: shared by the app and the runner, at least 16 characters. Without it the runner refuses to
  start and JDBC resources say "This instance has no JDBC runner".
- `JDBC_MAX_CONCURRENT` (32 queries at once), `JDBC_MAX_POOLS` (50 pools kept); idle pools close after 10 minutes.
- The app finds the runner at `JDBC_RUNNER_URL` (Compose: `http://jdbc-runner:8080`) and listens for its tunnelled
  connections on `JDBC_FORWARDER_PORT` (Compose: 7070; see SSH below).

**Turning it on in an existing stack:** add `JDBC_RUNNER_TOKEN` to `.env`, build the runner
(`docker compose build jdbc-runner`), rebuild the app image (the migration `0049_jdbc_drivers` runs with it), then
`docker compose up -d`. Rotating the token: change it in `.env` and recreate `jdbc-runner`, `api` and the workers
together.

## Making a resource

Resources → New resource → **JDBC**. Pick the driver, then:

- **Fields or a URL.** With fields the form shows the URL it makes (Oracle: service name, SID or a TNS alias; Snowflake:
  account, warehouse, database, schema, role; ClickHouse: host, port, database, HTTPS). Uploaded drivers take a URL as
  their documentation writes it. Put passwords and keys in the sign-in or the secret properties, never in the URL.
- **Sign-in.** A password, for every driver. Snowflake also: a **key pair** (the PKCS#8 private key, PEM, and its
  passphrase if encrypted; the public key set on the user with `ALTER USER … SET RSA_PUBLIC_KEY`) or **OAuth** (below).
  Oracle: a **wallet** (below).
- **Properties.** The driver's own settings by name; secret ones (an API key) in "Secret connection properties".
- **Read-only.** Only statements that read run (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN); anything else is refused
  before it reaches the database (Oracle and Snowflake commit DDL on their own). Where the driver has transactions the
  query also runs in one that is always rolled back; ClickHouse's server also gets its own `readonly` setting. It
  guards against mistakes (a PL/SQL block or a stored procedure is refused, but a function that writes isn't seen): for
  security, sign in as a user that can only read.

### Snowflake OAuth

A Snowflake admin creates the OAuth app, using the redirect URI the form shows:

```sql
CREATE SECURITY INTEGRATION optiply_workflows
  TYPE = OAUTH ENABLED = TRUE OAUTH_CLIENT = CUSTOM OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
  OAUTH_REDIRECT_URI = '<the redirect URI>' OAUTH_ISSUE_REFRESH_TOKENS = TRUE OAUTH_REFRESH_TOKEN_VALIDITY = 7776000;
SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('OPTIPLY_WORKFLOWS');
```

The client id and secret go in the resource; the **role** field is the role sessions take (scope
`session:role:<ROLE>`; the role must be granted to the people signing in, and `ACCOUNTADMIN`/`SECURITYADMIN` are
blocked by Snowflake). Each person connects their own account (or one shared account, if chosen) in the resource's
connections panel; a session signed in as one person never runs another's query.

### Oracle wallets

For Autonomous Database (or any mTLS listener): download the wallet zip from the console, tick "Connect with a wallet",
choose the zip (the form lists its `tnsnames.ora` aliases, e.g. `mydb_high`), and connect by **TNS alias**. Auto-login
wallets (`cwallet.sso`) need no password; a wallet with only `ewallet.p12` needs its password. The zip is stored
encrypted and unpacked only in the runner's memory, per pool.

## Uploaded drivers

Settings → **JDBC drivers** (admins): upload the vendor's jar, its driver class (`com.ibm.db2.jcc.DB2Driver`, from
their documentation) and a name. The page shows each jar's SHA-256: compare it with the vendor's. A driver is code the
runner runs next to other resources' connections: upload only vendors' own jars. A driver can't be deleted while a
resource uses it. The runner gets a jar the first time a resource needs it (and again after a restart).

A driver that needs other jars beside it won't load: use the vendor's single ("shaded", "all") jar.

## SSH tunnels

A JDBC resource can connect through an SSH server (and jump hosts, or Google IAP) like Postgres and MySQL
(`docs/runbooks/ssh-tunnels.md`). Also list the **hosts to reach through the tunnel**: `host:port`, as the URL writes
them (several for a cluster). The SSH side stays in the app: the runner connects back to the app process holding the
tunnel (port `JDBC_FORWARDER_PORT` on the `executor` network) with a secret per tunnel, and the bytes go through SSH.
The URL keeps the database's real names, so TLS still checks them.

- "Could not connect through the SSH tunnel: …": the reason is the SSH side's (which server couldn't open what).
- Port 8080 (the runner's own) can't be tunnelled.

## Troubleshooting

- **"The JDBC runner isn't reachable"**: `docker compose ps jdbc-runner`, its logs; the app's `JDBC_RUNNER_URL`.
- **"refused this instance's token"**: the app's and the runner's `JDBC_RUNNER_TOKEN` differ: recreate both.
- **"The JDBC runner is busy"**: more than `JDBC_MAX_CONCURRENT` queries at once for 30 s.
- **A built-in driver "only takes its own URLs"**: the URL starts with another driver's prefix
  (`jdbc:oracle:thin:`, `jdbc:snowflake:`, `jdbc:clickhouse:`/`jdbc:ch:`).
- **Numbers as strings**: integers past 2^53 and decimals a double can't hold exactly come back as strings, on purpose.
- **"The URL names this machine"**: localhost and 127.x are the runner's own container, never a database.
- **Dates** in `{{ }}` are bound as timestamps in UTC: compare with `TIMESTAMP`/`DATE` columns, or pass a string and
  convert it in SQL (`TO_DATE({{ d }}, 'YYYY-MM-DD')`) for another zone.
