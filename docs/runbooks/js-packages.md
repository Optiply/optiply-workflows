# Runbook: JavaScript packages

Workflows and apps can use npm packages in their JavaScript code. Each workflow or app lists its packages, one a
line, and its code imports them at the top:

```js
import { format } from 'date-fns'
import { z } from 'zod'
return z.string().parse(format(new Date(), 'yyyy-MM-dd'))
```

The server installs the packages with npm and bundles them with esbuild into one script. That script runs in the
same sandboxes the code already runs in: the workflow's isolate (isolated-vm, in the API and worker processes) and
the app's Worker (in the viewer's browser). Nothing new runs as a service. The design is `docs/architecture.md`
§2.39; this page is for running it.

## How it fits

```
editor / run / publish ──▶ server: npm install (no scripts) ──▶ esbuild bundle ──▶ js_bundles (Postgres)
                                                                                      │
          workflow run: the isolate loads the bundle before the code ◀────────────────┤
          app: the page fetches /api/js-bundles/<hash>.js?app=<id>, the Worker loads it ◀┘
```

- **Where the packages come from:** the default registry (`NPM_REGISTRY_URL`), or the registries an admin added in
  **Settings → npm registries**. A registry for a scope serves that scope (`@acme/…`), and one without a scope
  replaces the default. These are the same registries component libraries use (M33): tokens are secret config vars
  in the default environment, and only npm sees them, in the build's own `.npmrc`.
- **What can run:** only packages that work without Node itself, which covers most data and utility packages
  (date-fns, zod, papaparse, uuid, lodash-es…). If a package uses a Node built-in such as `fs`, `net` or
  `child_process`, the build still succeeds and lists a warning: "X uses Node's fs, which the sandbox doesn't have".
  Code that then reaches that part fails with "X needs Node's fs". If an npm package of the same name is installed
  (`events`, `buffer`), it's used instead.
- **What never runs on the server:** package code. There are no install scripts, and esbuild only reads files.
- **Releases** keep their npm lock (`js_lock`) and their bundle (`js_bundle_hash`), so live runs and the published
  app always use the exact versions that were published.
- **Who can download a bundle:** bundles can contain private packages, so `/api/js-bundles/<hash>.js?app=<id>`
  serves a bundle only for an app the caller can see. A bundle named by one of that app's releases goes to anyone who
  can use the app. The bundle of the app's draft list (or of a Git branch draft's, `&branchDraft=<id>`) goes only to
  people who can edit the app, for the editor's preview. Workflows' bundles never leave the server. Anything else is
  a 404.

## Configuration

| Where | Variable | Default | What |
|---|---|---|---|
| api, worker | `NPM_REGISTRY_URL` | `https://registry.npmjs.org/` | The default registry, unless an admin's registry without a scope replaces it. |
| api, worker | `JS_BUNDLE_MAX_MB` | 5 | The largest bundle (1–50). It's loaded before code runs, and for apps it goes to every viewer's browser. |
| api, worker | `COMPONENT_BUILD_DIR` | a directory under the system's tmp | Where installs happen (`js-bundle-*` directories, removed afterwards). npm's download cache (`npm-cache`) is shared with component builds. |
| api, worker | `NPM_ALLOW_INSECURE_REGISTRIES` | off | Allows admin registries over http, for a local mirror. |

Fixed limits per install (the same as component libraries): 120 s, 200 MB of `node_modules`, and at most 30 packages
in a list. Each process runs at most two installs at a time, and the same install asked for twice at once runs once.

## How a bundle is found

The cache key covers the package list (sorted), every registry's scope and URL (not its token), and the lock the
install started from (a release's, or none for a draft). So:

- the same list is built once and shared by every workflow and app that lists it;
- **changing a registry** (adding one, or changing its URL) installs again on the next use;
- **changing only a token** doesn't.

A failed build is recorded too, and the editor shows npm's reason and output. For a minute it answers again rather
than running npm on every run (a schedule with a bad package). After that, the next run tries again; **Install now**
and **Try again** always do. A failure never replaces a good bundle that another process built for the same list.

Runs only fetch the bundle when some code imports a package. Listing packages that nothing imports yet costs
nothing.

**Retention** (in the worker's run-retention job): bundles unused for 30 days that no release names are deleted, and
so are failures older than a day. A release's bundle that has gone anyway is rebuilt from the release's lock when the
release runs or its app opens (`/api/js-bundles/<hash>.js` does that).

## When something goes wrong

- **"The package "x" isn't one of the workflow's (app's) JavaScript packages":** the code imports a package that
  isn't in the list. Add it in the workflow's Settings or the app's App settings.
- **"Import "zod/lib/x": only a package itself can be imported":** the bundle holds each package's main entry only.
  Import from the package (`import { x } from 'zod'`).
- **"The JavaScript packages couldn't be installed: …"** (a failed block, or publishing refused): npm's reason
  follows. The editor's JavaScript packages field shows npm's output under "Try again". Common causes:
  - **404 / not found:** the name is misspelled, or a private package's scope has no registry in Settings → npm
    registries.
  - **401 / 403:** the registry's token. The config var must be a secret with a value in the default environment.
  - **ETARGET / no matching version:** the range doesn't exist; check the versions on the registry.
  - **The packages bundle to N MB:** over `JS_BUNDLE_MAX_MB`. Use a smaller package, or raise the limit.
- **"X needs Node's fs, which the sandbox doesn't have":** that package (or this part of it) needs Node. Look for a
  browser build, or another package.
- **An app's JS query says "is not installed" in the editor right after the package was added:** the query ran on
  load before the package was there. Run it again, or reload the editor.
- **"Waiting for the workflow's JavaScript packages to install…"** in a block's log: a first install is under way.
  The block's timeout counts the wait. Use "Install now" in Settings beforehand, or give the block more time.

## Audit

Each new bundle is recorded as `js.bundle_built` on the workflow or app, with the packages, the installed versions,
the bundle's hash and size, any Node built-in warnings, and `fromLock` when it was rebuilt from a release's lock.
Registry changes are `npm_registry.*`, as before.
