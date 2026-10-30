# Runbook: built-in connectors

M27 added a built-in REST API resource and five resource types: GraphQL, Slack, HubSpot, SendGrid and Google Sheets.
The design is `docs/architecture.md` §2.30; this page is for setting each one up and finding out why one fails.

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

## Testing against fakes

`startFakeServices()` in `@ow/connectors/testing` serves fakes of all four services on one port (`/slack/api`,
`/hubspot`, `/sendgrid`, `/sendgrid-eu`, `/sheets/v4/spreadsheets`, `/drive`, `/google/token`), with `/_fake/state` to
look at what they were sent. Point a server at them with `SLACK_API_URL`, `HUBSPOT_API_URL`, `SENDGRID_API_URL`,
`SENDGRID_EU_API_URL`, `GOOGLE_SHEETS_API_URL` and `GOOGLE_DRIVE_API_URL`. Never set these in production.
