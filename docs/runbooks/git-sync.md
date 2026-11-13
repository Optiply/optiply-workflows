# Runbook: Git sync

Protected workflows, apps, library queries, modules, resources and config vars live in a Git repo: they're changed on
branches, reviewed in pull requests (GitHub) or merge requests (GitLab), and deployed when one merges into the deploy
branch. The design is `docs/architecture.md` §2.13 (M11), §2.23 (M20), §2.25 (M22) and §2.34 (M31: GitLab, the GitHub App); this
page is for connecting a repo and keeping it working.

## How it fits

```
editor ──Commit──▶ branch ──pull / merge request (opened by the instance)──▶ review ──merge──▶ deploy branch
                                                                                                  │
instance ◀── deploy ◀── push webhook (seconds) or polling (every GIT_POLL_SECONDS, 60 by default) ─┘
```

- **Settings → Git** (admins) holds one repo per instance: its URL, the deploy branch, the **host** (GitHub or GitLab),
  how to sign in, and the webhook secret. Several instances (staging, production) can share a repo, each with its own
  deploy branch; **Promote** opens a request from one deploy branch into another.
- The instance signs in **twice with the same credentials**: git itself (clone, fetch, push over https) and the host's
  API (pull or merge requests, and Test connection).
- Credentials are kept encrypted and never shown again. Pointing the repo at another server, or switching the host,
  asks for them again, so a stored token is never sent somewhere new.

## GitHub with a token

1. A **fine-grained personal access token** (or a machine user's), for this one repo: **Contents** and **Pull
   requests**, read and write (Metadata read comes with them). A classic token needs `repo`.
2. Settings → Git: the repo's https URL (`https://github.com/optiply/workflows.git`; GitHub Enterprise Server: its own
   address, and pick **GitHub** as the host), the deploy branch, **Sign in with: A token**, the token. **Save**, then
   **Test connection**: git's line (branches, what's on the deploy branch) and GitHub's ("GitHub: optiply/workflows";
   a warning when the token can't push).

## GitHub with a GitHub App

An App isn't tied to a person (nothing breaks when someone leaves), and its tokens last an hour.

1. **Make the App** (GitHub → Settings → Developer settings → GitHub Apps → New; or under the organization): any name,
   a homepage URL, **Webhook**: active, the payload URL and secret below (or leave it inactive and use a repo webhook),
   **Repository permissions**: Contents *Read and write*, Pull requests *Read and write*, Metadata *Read*; **Subscribe
   to events**: Push. Only on this account.
2. On the App's page: note the **App ID**, and **Generate a private key** (a `.pem` file downloads).
3. **Install** the App on the organization, for **only** the workflows repo.
4. Settings → Git: the repo URL, **Sign in with: A GitHub App**, the App id, the private key (paste the whole `.pem`,
   `-----BEGIN … PRIVATE KEY-----` included). **Save**, **Test connection**: "GitHub App <name>, installed on <account>
   (<repo>)", or what the installation lacks ("The App's installation needs pull_requests: write").

The instance signs a short JWT with the key, finds the installation from the repo, and mints installation tokens
limited to the repo; each is reused until 5 minutes before it expires, and minted again if GitHub refuses one. To
rotate the key: generate a new one on the App's page, paste it here, save, then delete the old one there.

## GitLab (gitlab.com or self-managed)

1. An **access token**: a **project access token** (the project → Settings → Access tokens) is best, or a group or
   personal one. Role **Developer** (Maintainer if the instance must push to protected branches, see below), scopes
   **api** (merge requests) and **write_repository** (pushing).
2. Settings → Git: the project's https URL (`https://gitlab.com/optiply/data/workflows.git`; nested groups are fine). A
   gitlab.com or `gitlab.…` address picks GitLab by itself; another server: pick **GitLab**. For an instance served
   under a path (`https://code.example.com/gitlab/…`), set **API URL** to `https://code.example.com/gitlab/api/v4`
   (it must be on the repo's own server, over https). The token. **Save**, **Test connection**: "GitLab: optiply/data/
   workflows (Developer)", or a warning about the role or a missing scope.

Git signs in as `oauth2` with the token; the API gets it as `PRIVATE-TOKEN`.

## The push webhook

Without it, the instance reads the deploy branch every `GIT_POLL_SECONDS`; with it, a merge deploys within seconds.
**Generate** a webhook secret in Settings → Git (copy it before saving: it isn't shown again), save, then:

| | GitHub (repo or App webhook) | GitLab (project → Settings → Webhooks) |
|---|---|---|
| URL | `https://<instance>/api/git/webhook` | the same |
| Secret | **Secret**: the webhook secret (signs each delivery, `X-Hub-Signature-256`) | **Secret token**: the webhook secret (sent as `X-Gitlab-Token`) |
| Content type | `application/json` (form-encoded works too) | — |
| Events | Just the push event | **Push events**, branch filter: the deploy branch |
| TLS | — | SSL verification on |

GitHub's ping and GitLab's "Test → Push events" both answer 200. Other events and other branches are acknowledged and
ignored. The instance must be reachable from the host (gitlab.com and github.com can't reach a private address: use
polling there).

## Protected branches on the host

The instance pushes to **its own branches** (`protect/…`, branch drafts) and opens requests into the deploy branch; it
pushes to the deploy branch itself only for an admin's emergency rollback and for the first commit of an empty repo.
Branch protection on the deploy branch (required reviews) is what it's for. When the host refuses a push, the
message says what to change:

- GitLab: "the branch is protected on GitLab": give the token's role *Allowed to push* in the project's protected
  branches, or the Maintainer role.
- GitHub (`GH006`): "the branch is protected on GitHub": let the token's user or the App bypass the rule, or protect
  the objects here so changes go through pull requests.

## When it fails

| It says | What to do |
|---|---|
| `git … failed: Authentication failed` / Test connection: auth | The token (expired, revoked, wrong repo), or the App's key and installation. |
| `GitHub said 401 … Check the GitHub App's id and private key` | The App id, or a key from another App (or deleted on GitHub). |
| `… The GitHub App isn't installed on optiply/workflows` | Install the App on the repo (the App's page → Install App), or add the repo to its installation. |
| `The App's installation needs …` | The App's permissions (its settings), then accept the new permissions on the installation. |
| `GitHub said 403/401 … The token needs Pull requests (read and write)` | The fine-grained token's permissions. |
| `GitLab said 401 … The token needs the api scope and at least the Developer role` | A new token with `api` and `write_repository`, or a higher role. |
| `GitLab said 404 … Is the repo URL right, and can the token see the project?` | The URL (the full path, groups included), the API URL for an instance under a path, or the token's project. |
| `The repo is on another host now: enter the token again` | Expected after changing the URL's server or the host: enter the credentials again. |
| `No pull request was opened` / `No merge request was opened` | The branch is pushed; open the request on the host by hand, and fix what the message says. |
| Webhook deliveries answered 401 | The secret differs (GitHub: *Secret*; GitLab: *Secret token*), or the host is set wrong (GitLab's token isn't GitHub's signature). |
| Deploys stall with a lease | Another process is deploying; Settings → Git shows it. |

Test connection never writes. The audit log records settings changes (`git.settings_updated`, with the host, the
sign-in, and which secrets changed, never their values).

## Not supported

Bitbucket and Azure DevOps; making the GitHub App from here (the manifest flow); people signing in with GitHub or
GitLab; status checks or comments on requests; GitLab CI or GitHub Actions triggering from here.
