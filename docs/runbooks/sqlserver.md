# Runbook: Microsoft SQL Server resources

A SQL Server resource (M38, `docs/architecture.md` §2.42) queries SQL Server or Azure SQL from workflows, apps and the
playground, like Postgres and MySQL. No extra service: the app connects itself (tedious).

## Making a resource

Resources → New resource → **Microsoft SQL Server**:

- **Host and port** (1433), or an **instance name** (`SQLEXPRESS`: its port is looked up through the SQL Browser
  service; not through an SSH tunnel, where you give the port), and the **database**.
- **Sign in with:**
  - **SQL Server login**: user and password.
  - **Windows account (NTLM)**: the domain (`CORP`), the user and the password.
  - **Entra ID user and password**: `name@company.com`, the password, and the client id of an app registration allowed
    to sign users in with a password (a public client). Accounts that need MFA can't sign in this way: use an app.
  - **Entra ID app (service principal)**: the app's client id, its directory (tenant) id and a client secret. Make it a
    user in the database first: `CREATE USER [app-name] FROM EXTERNAL PROVIDER; ALTER ROLE db_datareader ADD MEMBER [app-name];`
- **Encryption:** *Require* (the default: encrypted, the certificate not checked), *Verify certificate and hostname*
  (with a CA for a private one), or *Disable* (Azure SQL refuses it).
- **SSH tunnel**, **max rows**, **statement timeout** and **pool size** as for the other databases.

## Queries

`{{ }}` values are bound as `@p1`, `@p2`… (through `sp_executesql`); arrays become one parameter per item, so
`id IN ({{ ids }})` works. Use T-SQL as usual: `TOP`, `OFFSET … FETCH`, `@variables`, `#temp` tables (names like `@p1`
are taken). With several result sets, the first is the result. A batch that leaves a transaction open fails (SQL Server's
error 266) and is rolled back.

Types: DATE, DATETIME and DATETIME2 come back as written (`2026-10-14 09:30:00`), DATETIMEOFFSET as an instant in UTC,
BIGINT past 2^53 as a string. **DECIMAL and MONEY are numbers**: past 15 significant digits they lose precision, so
`CAST(x AS VARCHAR(40))` for exact values.

## Read-only

Every query runs in a transaction that is always rolled back. A query that changes rows fails ("… and the change was
rolled back"); `COMMIT`/`ROLLBACK` are refused before running; schema changes are rolled back without an error (they
report no rows). It guards against mistakes; for security, use a login with only `db_datareader`.

## Troubleshooting

- **"Login failed for user …"**: the login, its password, or the database it may open (`CREATE USER … FOR LOGIN`).
- **"certificate"** errors with *Verify*: the server's certificate doesn't match the host name, or its CA isn't given.
- **Entra sign-in errors** come from Entra (AADSTS codes): the app registration, its permissions, MFA.
- **"The variable name @p1 is reserved"**: rename the T-SQL variable.

**Tests:** `packages/connectors/test/mssql.test.ts` runs SQL Server 2022 in Docker. On Apple silicon the image is
emulated and too heavy next to the other test containers: run them with `MSSQL_TESTS=1` (CI always runs them).
