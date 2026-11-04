# Runbook: custom components

Custom components (M25) are React components written in the platform, in **component libraries**, built on the
server and run in apps inside a sandboxed frame. The design is `docs/architecture.md` §2.28; this page is for running
it.

## How it fits

```
library editor ──Build / Publish──▶ API ──npm install (no scripts)──▶ NPM_REGISTRY_URL
                                     │──esbuild──▶ component_bundles (Postgres)
app page ◀──GET /api/component-bundles/<hash>.js|css (signed in)──┘
   └─ <iframe sandbox="allow-scripts" srcdoc=…>  CSP: only the library's allowed origins
        └─ the frame runtime (React, ReactDOM, the SDK) + the bundle (from a blob: URL)
```

- **Builds run in the API process** that gets the request (Build in the editor, Publish, a Git deploy in the
  deploying process), two at a time per process. A build writes the library's files to a fresh directory under
  `COMPONENT_BUILD_DIR`, runs `npm install` there, bundles with esbuild, stores the result in `component_bundles` and
  removes the directory. The same files, dependencies and lock again are found in the table, not rebuilt.
- **npm runs without install scripts** (`ignore-scripts`), with one registry, its own empty npmrc files and a HOME
  in the build directory, and only `PATH` from the server's environment: no secrets, no `~/.npmrc` tokens reach it.
  Bundling reads only files inside the build directory (an `import` of `/etc/…` or `../../…` fails the build).
- **Bundles are served to anyone signed in** by their SHA-256 (`/api/component-bundles/<hash>.js`, cached a year):
  whoever opens an app needs nothing on the library, and the hash can't be guessed. The app's page fetches them and
  hands them to the frame as text; the frame has no URL of ours.

## Configuration

| Variable | Default | What |
|---|---|---|
| `NPM_REGISTRY_URL` | `https://registry.npmjs.org/` | The registry dependencies come from, unless an admin's registry without a scope replaces it (M33, Settings → Components). |
| `NPM_ALLOW_INSECURE_REGISTRIES` | off | M33: admin-defined registries over `http` (a local mirror, tests). |
| `COMPONENT_BUILD_DIR` | `<tmp>/ow-component-builds` | Builds' working directories and npm's download cache (`npm-cache/`). Disposable; a volume only keeps the cache across restarts. |

Fixed limits per build: 120 s for `npm install` (then killed), 200 MB of installed packages, a 5 MB bundle (JS and
CSS), 2 MB of source in a library, 200 files, 100 components. The image needs `npm` (in `node:24-bookworm-slim`) and
the server's `esbuild` dependency (its platform binary comes with `pnpm deploy`).

## The CLI (M33)

Developers can work on a library in their own editor with **`ow-components`**, one Node 20+ file the instance
serves (`GET /api/cli/ow-components.mjs`, no sign-in; the server's build makes it at `dist/cli/ow-components.mjs`).
The library editor's **Use the CLI** shows the commands for that instance.

```
curl -O https://workflows.example.com/api/cli/ow-components.mjs
node ow-components.mjs login https://workflows.example.com      # paste a token from Settings → Access tokens
node ow-components.mjs init price-widgets                        # or: pull price-widgets
cd price-widgets && node ../ow-components.mjs dev                # each save: push into the draft, build
node ../ow-components.mjs push --build --publish 1.2.0 --notes "…"
node ow-components.mjs push --prebuilt dist/ --slug price-widgets --version 2.0.0   # a bundle built elsewhere
```

- **The folder** is the Git layout: `library.json` (name, description, components, allowed origins),
  `package.json` (dependencies), the sources; `.ow-components.json` keeps what it last synced (the draft revision,
  a hash of the files). Hidden files, `node_modules` and `dist` aren't pushed.
- **push** saves the folder as the draft, with the revision it last saw: if someone changed the draft since (in the
  browser), it refuses; `pull` (after keeping your changes) or `push --force`. `--build` prints the build's problems
  as `file:line:column`. Open library editors follow a push and rebuild their Preview ("Pushed from the CLI by …").
- **Sign-in:** personal access tokens (Settings → **Access tokens**, every user makes their own; shown once, sha256
  stored; expiry 30/90/365 days or never). A token acts as its user, with their permissions, on component libraries
  only (`componentLibraries.*`, `me`, `folders.list`); anything else answers 403; a revoked or expired token, or a
  disabled user's, 401. `login` keeps the URL and token in `~/.config/ow-components/config.json` (mode 600); in CI
  set `OW_URL` and `OW_TOKEN`. Admins see and revoke everyone's tokens (Everyone's tokens). What a token does is
  audited as its user with `via: owpat_xxxxxxxx`; pushes also as `component_library.draft_pushed`.

## Private npm registries (M33)

Admins add registries in **Settings → Components**: one per **scope** (`@acme` → its registry), or one without a
scope that replaces `NPM_REGISTRY_URL` for every other package. The token is a **secret config var**, its value in
the **default environment**; a build writes it to its own temporary `.npmrc` (`//host/path/:_authToken=…`, mode
600), which only npm reads (install scripts never run, so no package code sees it), and npm's log is scrubbed of it.
The lock keeps tarball URLs, never the token. **Test** asks the registry `/-/whoami` with the token. Libraries need
nothing: an `@acme/…` dependency resolves from `@acme`'s registry. A token var without a value fails the build's
install naming it, and so does one with a space or line break (it would add settings to `.npmrc`).
`NPM_ALLOW_INSECURE_REGISTRIES=true` allows `http://` registries (a local mirror, tests). The `.npmrc` lives beside
the build directory, never in it (the bundler reads what a library imports from inside it), and goes once npm is
done. **Who defines registries chooses which secret config var goes to which URL** (Test sends it too): the same
trust as a workflow's REST query, which can send `{{ configVars.X }}` anywhere; keep the admins few.

## Auto height (M33)

A component may declare **Grows with its content** (`autoHeight` in `library.json`); each instance in an app has
**Height: auto | fixed** (`heightMode`), its default from the component. On Auto the frame reports how far down what
the component rendered reaches (at most 4000 px), and the app's grid lays the component out at that many rows,
moving what's under it (and back up when it shrinks); on Fixed it keeps its rows and its frame scrolls, as before.
In the app editor's canvas a component keeps its stored height (resize it there for Fixed). A component that fills
its frame (`height: 100%`) reports the frame's own height: on Auto it stays as it is.

## What the frame does and doesn't guarantee

- The frame's origin is **opaque** (`sandbox="allow-scripts"` without `allow-same-origin`): it can't read the app's
  page, its cookies or the platform's API (reading `document.cookie` throws), and it can't open windows or navigate
  the page.
- Its **Content Security Policy** allows fetches, images, fonts and media only from the library's **allowed
  origins** (plus `data:`/`blob:`), forms nowhere, scripts inline and from `blob:` only.
- **Not every way out is covered by a policy.** A component can navigate its own frame (the page notices the second
  load, removes the frame and reports "tried to leave its frame", but the request has gone), and WebRTC isn't covered
  by CSP in every browser. So allowed origins are a guard, not a guarantee: **who may publish a library (Edit on it)
  is trusted with the data its components are given.** Publishing a change to the allowed origins needs an admin
  (audited as `component_library.origins_changed`), and so does choosing who gets Edit.

## Bundles and retention

`component_bundles` keeps every build: drafts' and releases'. The daily retention job (the worker's `RetentionJob`,
`RUN_RETENTION_DAYS` > 0) removes bundles **no release keeps** that are older than 7 days; its log line counts them
(`componentBundles`). Releases' bundles stay as long as their releases.

## When something's wrong

- **"Installing packages failed"** in the editor: the message is npm's error (a 404 is a package or version the
  registry doesn't have); "npm's output" under it has the rest. Behind a proxy, set `NPM_REGISTRY_URL` to a mirror the
  server can reach.
- **`spawn npm ENOENT`**: the server's image or host has no `npm` on `PATH`.
- **A private package answers 401 or 404**: its scope has no registry in Settings → Components, or the token's
  config var has no value in the default environment (the build says which), or the token can't read that package.
- **The CLI says "The draft changed"**: someone edited the draft in the browser since the folder last synced: pull
  (after keeping your changes elsewhere) or `push --force`. **401**: the token is revoked, expired or its user
  disabled; **403 outside its scope**: tokens only reach component libraries.
- **"took over 120 s"**: a slow registry or a very large dependency tree; the next build reuses npm's cache.
- **"The bundle is … MB"**: drop a large dependency, or import only the parts used.
- **A component shows "stopped responding"**: its code loops or blocks for 10 s; Restart in the box starts it
  again. The app's console (the editor's) has its errors as `<component>: …`.
- **A component shows "isn't available"** in an app: the library or the release it names is gone, or (in the
  editor) the person can't use the library.
- **Git deploys of a library fail** with "The build failed: …": the same build problem as in the editor; fix it on a
  branch and merge. A deploy starts from the live release's lock, so packages move only as far as their ranges allow.
