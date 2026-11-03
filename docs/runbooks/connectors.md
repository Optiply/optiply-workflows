# Runbook: built-in connectors

M27 added a built-in REST API resource and five resource types: GraphQL, Slack, HubSpot, SendGrid and Google Sheets.
M29 added S3, Stripe, Airtable, Jira, Notion, Salesforce and OpenAPI resources. The designs are `docs/architecture.md`
§2.30 and §2.32; this page is for setting each one up and finding out why one fails.

## What they share

- Every one of them is HTTP through the same core as REST resources (`packages/connectors/src/http-core.ts`): private
  addresses are refused, redirects are followed only to allowed hosts, responses are capped, and tokens and keys are
  scrubbed from results, errors and logs.
- Slack, HubSpot and Google Sheets can also sign in through **OAuth** (M9's flow): register an app with the service,
  paste its client id and secret into the resource, copy the **Redirect URI** shown under the form into the app, save,
  then **Connect account** under the settings. One shared account per environment, or each person their own.
- Service queries are an **action** and its fields; every field is a template. The forms come from
  `packages/connectors/src/services/actions.ts`. Each has a "Call any …" action for what the forms don't cover.
- Queries are counted in `ow_connector_queries_total{type, action, outcome}` (`outcome` is `ok` or the error's code:
  `auth_required`, `http`, `query`, `blocked`, …).

## The built-in REST API resource (`rest_api`)

- There on every instance (made by `migrate`), usable by everyone at first: narrow it on its Access tab. Its settings
  can't be changed.
- Queries give a **full URL** and their own sign-in (bearer, basic or an API key). In workflows, read secrets from a
  **secret config var**: `{{ configVars.STRIPE_KEY }}`. Secret config vars reach **published** runs only; a draft run
  gets nothing for them, so test a call with a secret from a live release (or put a test value in the playground).
- **Private addresses are refused**: this network, `localhost`, link-local, and names resolving to them. To let it reach
  an internal host, an admin sets `REST_API_PRIVATE_HOSTS` (comma-separated names or `*.example.internal` patterns) on
  the API and worker processes. For anything that needs more (an SSH tunnel, OAuth, allowed hosts), make a REST
  resource instead.
- In **apps**, the URL's scheme and host must be typed out and ended by `/`, `?` or `#` before the first `{{ }}`: the
  app's viewers send values, and they may only fill the path and parameters. The error says so.

## GraphQL

- The **Endpoint URL** is where queries are posted. Auth, headers, allowed hosts, private network and SSH tunnels are
  REST's.
- **Test connection** introspects the schema and counts its types. "introspection is turned off" means the endpoint
  works but the editor has no schema (no completions or checks).
- The editor's schema is read in the default environment (or the first one the resource is set up in) and kept 10
  minutes; it follows a settings change at once.
- Values go in **variables** (`$id` in the query, `{"id": {{ … }}}` in the variables); `{{ }}` in the query itself is
  refused. A response with `errors` fails the query with the first message and its path; all errors and any partial
  `data` are in the error's details.

## Slack

- **Token:** create a Slack app (api.slack.com/apps), add **bot token scopes**, install it to the workspace, and paste
  the `xoxb-…` token. Scopes per action: `chat:write` (send, edit, delete; `chat:write.public` for channels the bot
  isn't in, `chat:write.customize` for a name or icon), `channels:read` / `groups:read` (list channels), `users:read`
  and `users:read.email` (people, find by email), `files:write` (upload).
- **Invite the bot** to private channels it posts in (`/invite @your-app`).
- Slack answers errors as `ok: false`: the query fails with `Slack: <code>` (`not_in_channel`, `channel_not_found`,
  `missing_scope`, `invalid_auth`, …). A rate limit is waited out once (up to 30 s), then fails.
- Lists are fetched page by page up to **At most** (1,000 by default); `metadata.truncated` says there were more.

## HubSpot

- **Private app:** Settings → Integrations → Private apps → Create; give it the CRM scopes the queries need
  (`crm.objects.contacts.read`/`.write`, `crm.objects.deals.read`/`.write`, `crm.objects.companies.*`, …) and paste the
  access token (`pat-…`).
- **OAuth:** a public app in a HubSpot developer account; its scopes must match the resource's **Scopes**.
- Errors read `HubSpot: <message>` with HubSpot's `category` and `correlationId` in the details: quote the correlation
  id to HubSpot's support.
- Search pages through HubSpot's search API (200 at a time, 10,000 at most: HubSpot's own limit); search results can
  lag a few seconds behind a write.

## SendGrid

- Settings → API Keys → Create; **Restricted access** with **Mail Send** is enough to send (Test connection warns when
  the key can't). Verify the sender (Single Sender or domain authentication) first, or SendGrid refuses the mail.
- **Region EU** for subusers pinned to the EU (`api.eu.sendgrid.com`); their keys don't work on the global host and the
  other way round.
- A send answers `{messageId, status: 202, recipients}`: 202 means accepted, not delivered. Delivery is in SendGrid's
  Activity feed, by the message id.

## Google Sheets

- **Service account key:** in Google Cloud, enable the **Google Sheets API** (and the **Google Drive API** to share new
  spreadsheets), make a service account and a JSON key, and paste it. Then **share each spreadsheet with the service
  account's email** (Editor to write). A spreadsheet it can't open fails with "Share the spreadsheet with …".
- **This server's identity** (admins only, `GOOGLE_SERVER_IDENTITY=allow`, as Pub/Sub's): it is asked for the
  `spreadsheets` and `drive.file` scopes. A service account key file in `GOOGLE_APPLICATION_CREDENTIALS` works as is; a
  `gcloud auth application-default login` needs those scopes asked for
  (`--scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive.file`),
  and a VM's metadata server only gives the scopes the VM was created with.
- **OAuth:** a Google OAuth client (Web application) with the redirect URI; the scopes include `spreadsheets`. The
  account sees what that person sees.
- **Read** takes the first row as column names (blank ones become `column_<n>`, repeats `_2`); **append** and **update
  by key column** match objects to those names and refuse columns the sheet lacks. "As if typed" turns `"42"` into a
  number and `=SUM(…)` into a formula; "Stored as they are" doesn't.

## Amazon S3 (and S3-compatible stores)

- **Credentials:** M26's AWS identity (an access key, a role to assume, or the server's own credentials where the
  instance allows them: admins only). A policy for a reports bucket:
  `s3:ListBucket` on `arn:aws:s3:::bucket`, `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::bucket/*`.
  Test connection runs `HeadBucket` on the default bucket (so `s3:ListBucket` on it), else `ListBuckets`.
- **Other stores:** an admin sets the **Endpoint** (MinIO, Cloudflare R2 `https://<account>.r2.cloudflarestorage.com`,
  Google Cloud Storage `https://storage.googleapis.com` with HMAC keys) and usually ticks **Path-style URLs**. The SDK's
  CRC checksums are then sent only where S3 requires them (compatible stores refuse them).
- Objects over 10 MB can't be read or written by a query: give a **presigned URL** (GET or PUT, up to 7 days) instead.
  Presigned URLs act with the resource's rights until they expire; anyone holding one can use it.
- `AccessDenied` is the policy; `NoSuchBucket` the name or the region; `SignatureDoesNotMatch` the secret (or a clock
  off by minutes).

## Stripe

- Use a **restricted key** (Developers → API keys → Create restricted key) with only the resources your queries use;
  `sk_test_…` keys work against test mode. Test connection reads `/v1/balance` and says live or test.
- **Stripe-Version** can be pinned in the settings (empty: the account's default); **Connected account** acts as a
  Connect account.
- Every create and update carries an **Idempotency-Key**. Inside a workflow run it's made from the run and the request,
  so a retried block replays Stripe's first answer instead of charging twice; give your own key to dedupe across runs.
  Outside a run (the playground, apps) it's random.
- Errors show Stripe's message, and `details` has `type`, `code`, `declineCode`, `param` and `requestId` (search it in
  the Stripe dashboard's logs).

## Airtable

- A **personal access token** (airtable.com/create/tokens) with `data.records:read`, `data.records:write` and
  `schema.bases:read`, given access to the bases the queries use. A default base (`app…`, from the base's URL) saves
  typing it in each query.
- Records come back as rows: `{id, createdTime, ...fields}`. Writes go 10 records per request (Airtable's limit), in
  turn, so a long list takes a while; Airtable allows 5 requests a second per base, and a 429 is waited out once.
- `UNKNOWN_FIELD_NAME` is a field name that isn't in the table (names are case-sensitive); tick **Convert values** to
  let Airtable turn text into numbers, dates and new select options.

## Jira

- **Cloud:** the site (`https://<team>.atlassian.net`), the account's **email** and an **API token**
  (id.atlassian.com → Security → API tokens). Queries act with that account's permissions.
- **Data Center / Server:** the site's address and a **personal access token** (Profile → Personal Access Tokens); tick
  **Allow a private network address** for a site inside Optiply's network.
- Descriptions and comments are plain text; on Cloud they're turned into Atlassian Document Format. **Move an issue**
  takes the transition's name, its id, or the status it leads to; when none fits, the error lists the ones available
  from the issue's status.

## Notion

- An **internal integration** (notion.so/profile/integrations), its token in the resource. Then **share each page or
  database with it** (••• → Connections → the integration): `object_not_found` usually means it isn't shared.
- Ids can be pasted as Notion URLs. Properties are written and read as **plain values** by the database's schema
  (text, numbers, a select's name, a list of names for multi-select, `2026-11-04` or `{start, end}` for dates, true/false);
  anything else can be given as Notion's own property object.

## Salesforce

- The org's **My Domain URL** (Setup → My Domain) and a **connected app** (External Client App) with the `api` and
  `refresh_token` scopes:
  - **OAuth sign-in:** its consumer key and secret, the **Redirect URI** shown under the form as its callback URL, then
    **Connect account** (one per environment, or each person their own). PKCE is on.
  - **Client credentials:** enable the client credentials flow on the app and set its **Run As** user; queries act as
    that user.
- In SOQL each `{{ }}` is sent as a **quoted, escaped value** (strings, numbers, dates, lists for `IN`): write
  `WHERE Name = {{ name }}`, never `'{{ name }}'` (refused). Results follow `nextRecordsUrl` up to **At most**.
- Errors show Salesforce's message and `errorCode` (`INVALID_FIELD`, `REQUIRED_FIELD_MISSING`, `INVALID_SESSION_ID`
  means sign in again).

## OpenAPI

- REST's settings (base URL, auth incl. OAuth and custom flows, headers, allowed hosts, SSH) plus the **OpenAPI
  document**: fetched once from its URL by the server (public addresses only) or pasted, JSON or YAML, OpenAPI 3.0/3.1
  or Swagger 2.0, up to 5 MB. Fetching fills an empty base URL from the document's first server. Fetch again (and save)
  when the API changes; queries naming an operation the document dropped are flagged in the editor.
- Only references inside the document are followed (`#/components/...`); a document that refers to other files must
  be bundled first (`redocly bundle`, `swagger-cli bundle`).
- A query is an operation and its parameters by name as JSON (`query:name` where two places share a name); values go
  where the document says, by its styles. Binary uploads go through `multipart/form-data` with file objects.

## Testing against fakes

`startFakeServices()` in `@ow/connectors/testing` serves fakes of all four services on one port (`/slack/api`,
`/hubspot`, `/sendgrid`, `/sendgrid-eu`, `/sheets/v4/spreadsheets`, `/drive`, `/google/token`), with `/_fake/state` to
look at what they were sent. Point a server at them with `SLACK_API_URL`, `HUBSPOT_API_URL`, `SENDGRID_API_URL`,
`SENDGRID_EU_API_URL`, `GOOGLE_SHEETS_API_URL` and `GOOGLE_DRIVE_API_URL`. Never set these in production.

M29's fakes are on the same server: `/stripe`, `/airtable`, `/notion`, `/salesforce`, and Jira sites at `/jira-cloud`
and `/jira-dc` (a resource's site URL). Point a server at them with `STRIPE_API_URL`, `AIRTABLE_API_URL`,
`NOTION_API_URL` and `SALESFORCE_URL` (which replaces every Salesforce resource's My Domain). S3's tests run a real
S3-compatible store in Docker (`startTestS3`, Versity Gateway, which checks signatures).
