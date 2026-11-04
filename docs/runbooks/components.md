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
| `NPM_REGISTRY_URL` | `https://registry.npmjs.org/` | The registry dependencies come from. Public packages only: no credentials are sent (private registries are not in M25). |
| `COMPONENT_BUILD_DIR` | `<tmp>/ow-component-builds` | Builds' working directories and npm's download cache (`npm-cache/`). Disposable; a volume only keeps the cache across restarts. |

Fixed limits per build: 120 s for `npm install` (then killed), 200 MB of installed packages, a 5 MB bundle (JS and
CSS), 2 MB of source in a library, 200 files, 100 components. The image needs `npm` (in `node:24-bookworm-slim`) and
the server's `esbuild` dependency (its platform binary comes with `pnpm deploy`).

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
- **"took over 120 s"**: a slow registry or a very large dependency tree; the next build reuses npm's cache.
- **"The bundle is … MB"**: drop a large dependency, or import only the parts used.
- **A component shows "stopped responding"**: its code loops or blocks for 10 s; Restart in the box starts it
  again. The app's console (the editor's) has its errors as `<component>: …`.
- **A component shows "isn't available"** in an app: the library or the release it names is gone, or (in the
  editor) the person can't use the library.
- **Git deploys of a library fail** with "The build failed: …": the same build problem as in the editor; fix it on a
  branch and merge. A deploy starts from the live release's lock, so packages move only as far as their ranges allow.
