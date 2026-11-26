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
- **This server's identity** (admins only, `GOOGLE_SERVER_IDENTITY=allow`, as IAP's): it is asked for the
  `spreadsheets` and `drive.file` scopes. A service account key file in `GOOGLE_APPLICATION_CREDENTIALS` works as is; a
  `gcloud auth application-default login` needs those scopes asked for
  (`--scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive.file`),
  and a VM's metadata server only gives the scopes the VM was created with.
- **OAuth:** a Google OAuth client (Web application) with the redirect URI; the scopes include `spreadsheets`. The
  account sees what that person sees.
- **Read** takes the first row as column names (blank ones become `column_<n>`, repeats `_2`); **append** and **update
  by key column** match objects to those names and refuse columns the sheet lacks. "As if typed" turns `"42"` into a
  number and `=SUM(…)` into a formula; "Stored as they are" doesn't.

## Gmail

- **Google sign-in** (any editor): in Google Cloud, enable the **Gmail API**, make an OAuth client (Web application)
  with the resource's redirect URI, and paste its client id and secret. The scope is
  `https://www.googleapis.com/auth/gmail.modify` (read, label, draft and send; nothing deleted for good; use
  `gmail.readonly` to only read). Then **Connect** in the resource: one shared mailbox per environment, or each person
  connects their own. Queries act as the connected account (`me`). `gmail.modify` is a **restricted** scope: an app
  outside your Workspace (External) needs Google's verification; an **Internal** OAuth consent screen doesn't.
- **A Workspace service account with domain-wide delegation** (admins only: one key reaches every mailbox of the
  domain): make a service account and a JSON key in a project with the Gmail API enabled; then a Workspace super admin
  opens **admin.google.com → Security → Access and data control → API controls → Manage domain-wide delegation**, adds
  the service account's **client id** (the key's `client_id`, a number) with the scope
  `https://www.googleapis.com/auth/gmail.modify`. Paste the key and a **Mailbox** (`support@optiply.nl`); a query's
  own **Mailbox** field acts as another. A refused token says "is domain-wide delegation set up for its client id and
  these scopes?"; it can take minutes to apply after adding.
- **Send / Create a draft** build a MIME message: To/Cc/Bcc as a list or comma-separated (`Name <a@b>` works, names
  in any language), a UTF-8 subject, text and/or HTML (both: the mail carries both), attachments as file objects
  (`{base64, filename, contentType}`: a webhook's uploads, or **Get an attachment**'s result). **Reply to message**
  (a message id) puts the reply in its thread with `In-Reply-To` and `References`, and fills an empty To with the
  sender (or Reply-To) and an empty Subject with "Re: …". **From** must be one of the mailbox's send-as aliases.
- **Search** takes Gmail's search box syntax (`from:… is:unread newer_than:2d`) and labels by id or name; each result
  has its headers and snippet (one call per message; turn **With headers** off for ids only). **Get an email** decodes
  the text and HTML bodies and lists attachments; **Change labels** takes names too (remove `UNREAD` to mark read).

## Microsoft Teams

- **Microsoft sign-in** (Graph: teams, channels, chats): in **entra.microsoft.com → App registrations → New
  registration**, a web app with the resource's redirect URI; under **Certificates & secrets** a client secret (it
  expires: note when); under **API permissions → Microsoft Graph → Delegated** add `User.Read`,
  `User.ReadBasic.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Send`,
  `ChannelMessage.Read.All`, `Chat.ReadWrite`, `TeamMember.Read.All` and **Grant admin consent** (an Entra admin:
  `ChannelMessage.Read.All` and `TeamMember.Read.All` need it). In the resource: **Tenant** (your tenant id or
  `optiply.nl`; `organizations` takes any work account), the client id and secret, then **Connect**. Messages are
  posted **as the connected person**: Graph lets an app post to channels only on someone's behalf. A shared account
  posts as whoever connected it; "Each person connects their own" posts as the one running it.
- **A channel's Workflows webhook** (posting only, nothing to register): in the channel, **··· → Workflows → "Post to
  a channel when a webhook request is received"**, then copy its URL into **Webhook URL** (a secret: its signature is
  in it). Only `https://…logic.azure.com/…`, `…api.powerplatform.com/…` and the old `…webhook.office.com/…` URLs are
  taken. **Post through the webhook** sends the text as an Adaptive Card, or a whole card you give; the flow posts it
  as the person who made the flow. Test connection sends nothing (it would post).
- **Post to a channel / Reply in a thread / Send a chat message**: text (escaped) or HTML; **Mention** puts the people
  (emails or ids, looked up for their names) at the start; **Adaptive Card** attaches a card (design one at
  adaptivecards.io/designer); importance. A chat message goes to a chat id, or to a person's one-on-one chat (Graph
  answers the existing one, or starts it). Ids: **List teams**, **List channels** (`19:…@thread.tacv2`), **List
  chats**. Graph's errors keep its code and `request-id` (for Microsoft support).

## Amazon S3 (and S3-compatible stores)

- **Credentials:** M26's AWS identity, one of:
  - **an access key** of an IAM user (the secret kept encrypted, never shown again);
  - **a role to assume** with that key (or with the server's credentials): its ARN and, if its trust policy asks for
    one, the external id; credentials are short-lived and renewed, and the role may be in another account;
  - or **this server's own credentials** (the SDK's default chain: environment, `~/.aws`, SSO, web identity, ECS and
    EC2 roles): off unless `AWS_SERVER_IDENTITY=allow`; only admins choose it, or change the region or role used with
    it. With Docker Compose on a Mac, `docker-compose.aws.yml` mounts `~/.aws` read-only and opts in.

  A policy for a reports bucket:
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
- Every create and update carries an **Idempotency-Key**: the one given in the query, else a new one per query
  execution (kept for that execution's own retries, such as a 429 waited out). Give your own key, made from something
  that identifies the payment (`order-{{ startTrigger.data.orderId }}`), so a retried block or a second run can't
  charge twice: Stripe answers the first result again. Stripe also keeps a 500 under its key for 24 hours, so change
  the key to try a failed charge again.
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
- In SOQL each `{{ }}` is sent as a **quoted, escaped value** (strings, numbers, lists for `IN`): write
  `WHERE Name = {{ name }}`, never `'{{ name }}'` (refused). A value that is exactly an ISO date (`2026-11-03`) or
  date-time with a zone (`2026-11-03T10:00:00Z`) goes unquoted, as SOQL's date literals must. Results follow
  `nextRecordsUrl` up to **At most**.
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

## BigQuery's sign-in

BigQuery is a database resource (not HTTP through the core above), but it can sign in through OAuth too:

- **Service account key** (the default; resources saved before have no `auth` and keep it): the key signs a JWT for a
  token; every query runs as the service account. It needs **BigQuery Job User** in the project, plus Data Viewer (or
  Editor) on the datasets.
- **OAuth sign-in (a Google account)**: a Google OAuth client (Web application) in the Google Cloud console with the
  **Redirect URI** from the form, an **Internal** consent screen, and the scope `https://www.googleapis.com/auth/bigquery`
  (the default is `openid email` plus it). **Project** is required. Shared or each person's own; each account needs
  BigQuery Job User in the project. The token is only ever sent to `bigquery.googleapis.com`.
- **Each person's Optiply account (the Optiply data platform)**: each person signs in to Optiply (Auth0, PKCE, no client
  secret) and, before every BigQuery call, the connector exchanges that Optiply token at Google STS for a Google token
  of the same person, through the data platform's workload identity pool (as optiply-agent does). The data platform's
  `agent_api` table functions then return rows only for webshops that person is a member of:
  ``SELECT * FROM `optiply-data-platform.agent_api.webshop_product`('<webshop uuid>')``. Set up:
  - **Client ID:** the "Optiply Workflows" Auth0 app (the one the Optiply SDK resource signs in with); its Allowed
    Callback URLs must hold this site's `/api/oauth/callback` (the form shows it). It's a public app: no secret is
    ever sent (`clientAuth: 'none'`), and one left from a Google OAuth sign-in is dropped on save. **Sign-in domain**
    is one of Optiply's own, over https: `login.optiply.com` (default), `optiply.eu.auth0.com` (the same tenant by
    its Auth0 name) or `optiply-staging.eu.auth0.com`; nothing else is accepted, so nobody with Edit can send people
    to a look-alike sign-in page. Audience (`https://api.optiply.com/internal`) and scopes (`openid email
    offline_access`) are empty by default (their placeholders show the defaults). The identity pool isn't a setting:
    it's always the data platform's
    (`//iam.googleapis.com/projects/429012531216/locations/global/workloadIdentityPools/data-platform-users/providers/auth0`).
  - **Project** `optiply-workflows`, **Location** `EU`. Jobs run and are billed there; the project's daily query quota
    is 30 GiB (BigQuery's free tier is 1 TiB a month).
  - **Each person** needs BigQuery Job User in that project for their data-platform identity, which the pool names
    **by Optiply email** (not the Auth0 `sub`):
    `gcloud projects add-iam-policy-binding optiply-workflows --role=roles/bigquery.jobUser --condition=None
    --member='principal://iam.googleapis.com/projects/429012531216/locations/global/workloadIdentityPools/data-platform-users/subject/<their Optiply email>'`.
    Never grant it to the whole pool (`principalSet://…/*`): every Optiply customer can get a token from it, so any of
    them could bill queries to our project. A denied job's audit log (`protoPayload.authenticationInfo.principalSubject`)
    shows the exact identity. Granting by email is safe because the data team and the Auth0 admin confirmed
    (2026-11-26) that `https://optiply.com/email` comes only from verified, unique emails.
  - **What fails how:** STS refusing the token itself → one retry with a fresh Optiply token, then "Google refused
    your Optiply sign-in for data platform access (invalid_grant: …). Connect your account again."; STS refusing
    anything else (a wrong app or audience) → "… Check the resource's Optiply app and audience …" with no retry; STS
    busy or failing (429, 5xx) → "… right now (…). Try again shortly." with no retry; no Job User → BigQuery's `accessDenied` ("User does not have bigquery.jobs.create
    permission in project …"); not a member of the webshop → the function's own `no access: …` error (its membership
    copy can lag by up to 2 hours). Each person's own account always: workflows that run on their own can't use it.
- **What fails how:** nobody connected → "Connect your account to this resource to use it." (Test connection and
  queries, before any call to BigQuery); a scheduled run on a per-person resource → "nobody is behind this run"; an
  account without the role → BigQuery's own `accessDenied` ("User does not have bigquery.jobs.create permission …");
  a token BigQuery refuses is refreshed once; when Google refuses the refresh (access revoked, password changed),
  the account shows **Needs reconnecting**.
- The table list (the SQL editor's Tables panel) is read as the person who opens it, and cached per person.

## Testing against fakes

`startFakeServices()` in `@ow/connectors/testing` serves fakes of all four services on one port (`/slack/api`,
`/hubspot`, `/sendgrid`, `/sendgrid-eu`, `/sheets/v4/spreadsheets`, `/drive`, `/google/token`), with `/_fake/state` to
look at what they were sent. Point a server at them with `SLACK_API_URL`, `HUBSPOT_API_URL`, `SENDGRID_API_URL`,
`SENDGRID_EU_API_URL`, `GOOGLE_SHEETS_API_URL` and `GOOGLE_DRIVE_API_URL`. Never set these in production.

M29's fakes are on the same server: `/stripe`, `/airtable`, `/notion`, `/salesforce`, and Jira sites at `/jira-cloud`
and `/jira-dc` (a resource's site URL). Point a server at them with `STRIPE_API_URL`, `AIRTABLE_API_URL`,
`NOTION_API_URL` and `SALESFORCE_URL` (which replaces every Salesforce resource's My Domain). M37's Gmail fake is at
`/gmail/gmail/v1` (`GMAIL_API_URL`): mailboxes seeded with `fake.gmail.seed()`, sends kept as MIME in `fake.gmail.sent`;
its tokens are the fake Google token endpoint's (a key acting as a mailbox through `sub`) or OAuth tokens given with
`gmailTrust`. Teams' Graph fake is at `/graph/v1.0` (`MICROSOFT_GRAPH_URL`; the token `eyJ.fake-teams-token` is
Ada's) and its Workflows webhooks at `/teams-webhook/flow-1` (`TEAMS_WEBHOOK_URL`, the prefix such URLs may have).
S3's tests run a real
S3-compatible store in Docker (`startTestS3`, Versity Gateway, which checks signatures).
