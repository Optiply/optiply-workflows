# Runbook: SDK resources

An SDK resource (M37, `docs/architecture.md` §2.41) calls a company SDK (a Python or JavaScript package) from
workflows, apps and the playground. The package is installed by the package builder, the client is made by the
resource's **setup code** with the resource's token, and every call runs in the **SDK runner**: a fresh nsjail jail per
call (Python 3.12 or Node 24) whose only way out is a proxy that lets the resource's hosts through.

## The services

| Service | What it does | Network |
|---|---|---|
| `python-builder` | Installs SDKs: pip (wheels, as for Python blocks) and npm (`POST /build-npm`, no install scripts) into the `python-envs` volume (`<envId>/site`, `node/<envId>/node_modules`). | `executor` + `builder-egress` (the registries) |
| `sdk-runner` | Runs each call: the code-executor image's `sdk-runner` target. Mounts the env read-only into the jail; a per-call proxy on a Unix socket is the jail's only way out. | `executor` + `sdk-egress` (the SDKs' APIs) |

Settings (`.env`): `SDK_RUNNER_TOKEN` (shared by the app and the runner; without it the runner refuses to start and SDK
resources say so), `SDK_MEMORY_MB` (per call, default 512), `SDK_MAX_CONCURRENT` (default 4). The app finds the runner at
`SDK_RUNNER_URL` (Compose sets `http://sdk-runner:8080`). The builder needs `PYTHON_BUILDER_URL`/`TOKEN` as for Python
packages; npm registries over http need `NPM_ALLOW_INSECURE_REGISTRIES=1` on the builder.

Turning it on in an existing stack: add `SDK_RUNNER_TOKEN` to `.env`, rebuild the builder (it gained Node and npm) and
build the runner: `docker compose build python-builder sdk-runner`, then `docker compose up -d python-builder
sdk-runner`, and recreate `api` and `worker` (with `PUBLIC_URL` set as usual) so they get the runner's URL and token.

## Setting one up

1. Resources → **New resource** → APIs → **SDK (Python or JavaScript)**.
2. **Language**, then **Packages**, one per line: `acme-sdk==1.4.2` (pip) or `acme-sdk@^2.1.0`, `@acme/sdk` (npm). At most
   10. Pin versions: a range resolves again when the builder's cache is gone.
   - **Where they come from.** Python: PyPI or an admin's index (**Package index**, from Settings → Python, with its
     password from a secret config var). JavaScript: Settings → npm registries by scope (`@acme` → your registry with
     its token), the instance's default (`NPM_REGISTRY_URL`) for the rest.
   - **Not supported:** npm packages that need install scripts (native addons: `--ignore-scripts` is always on), Python
     packages with neither a wheel nor an sdist M32's jail can build, git URLs, local paths.
3. **Base URL** (given to the setup code) and **Allowed hosts** (one per line: `api.acme.com`, `*.acme.com` for its
   subdomains, `host:8443` for another port; ports 443 and 80 otherwise). Empty: the base URL's host only. **Allow a
   private network address** (admins only) lets the hosts be inside Optiply's network.
4. **Sign in with**: a pasted token, OAuth 2.0 client credentials (the server fetches the token, cached until a minute
   before it expires), or OAuth 2.0 sign-in (M9: a shared account per environment or each person's own; the resource's
   **Connect** button). Whichever: the setup code gets it as `token`. An SDK error carrying HTTP 401 with an OAuth
   sign-in makes one more call with a fresh token.
5. **Options** (JSON) and **Secret values** (by name, encrypted) for the setup code.
6. **Setup code**, which makes the client:

   ```python
   import acme_sdk

   def client(token, base_url, options, secrets):   # any of these may be left out
       return acme_sdk.Client(access_token=token, base_url=base_url, tenant=options.get("tenant"))
   ```

   ```js
   import { Client } from 'acme-sdk'

   export default async ({ token, baseUrl, options, secrets }) => new Client({ token, baseUrl })
   ```

7. **Save**, then **Test connection**: it installs the packages (the first time can take a minute), runs the setup code
   and describes the client: "The client (acme_sdk.Client) has 42 members; installed acme-sdk 1.4.2, …".

## Queries

- **Call a method**: a dotted path on the client (`orders.list`) and **Arguments** as JSON with `{{ }}`: a list is
  positional, an object is keyword arguments in Python (or the one argument in JavaScript), empty is none. Coroutines
  are awaited; a generator or (async) iterator (an SDK's pager) is read up to **At most** items.
- **Run code**: a function body with `client`, `params` (the **Parameters** JSON, with `{{ }}`) and `token`. Python
  returns a value (an awaitable is awaited); JavaScript is an async function body. The code itself isn't a template:
  values come in through Parameters.
- **Describe the client**: its methods (signatures, first doc line) and values, two levels deep. In the resource's
  **Query** tab, **Browse the SDK** lists them; clicking a method makes a Call query with it.

Results become JSON: Pydantic models, `to_dict()`, dataclasses and objects' public fields (Python); `toJSON`, Dates,
BigInts (as text), Buffers (base64), Maps and Sets (JavaScript). What the SDK prints is the run's log. The token and the
secret values are removed from results and logs (`[REDACTED]`), even when the code returns or prints them.

## The network, and when it says "Blocked"

The jail has its own network namespace with only a loopback: a forwarder on `127.0.0.1:3128` hands connections to the
proxy outside, which allows `CONNECT host:port` (HTTPS, end to end: certificates are checked by the SDK as usual) and
plain `http://` requests to the allowed hosts, resolves names itself, refuses private addresses unless allowed, and
connects to the address it checked. `HTTPS_PROXY`/`HTTP_PROXY` are set, and `NODE_USE_ENV_PROXY=1`, so `requests`,
`httpx`, `urllib`, `fetch` and Node's `http`/`https` use it. **An SDK whose HTTP client ignores proxy settings can't
connect** ("Network is unreachable"): aiohttp needs `trust_env=True` in the setup code; gRPC SDKs aren't supported.

- `Blocked: example.com:443 isn't in this resource's allowed hosts`: add the host (or `*.domain`) to Allowed hosts.
- `Blocked: … is on a private network`: an admin turns on the private network for the resource.
- `… doesn't resolve`: the runner's DNS (its `sdk-egress` network) can't find the name.

## Errors

| Code | Meaning |
|---|---|
| `sdk` | The SDK raised: its message, `type`, `status` (when the error has one), the snippet's `line`, blocked hosts. |
| `sdk_method` | No such method on the client (Describe lists them); names starting with `_` aren't allowed. |
| `sdk_install` | The packages couldn't be installed: pip's or npm's reason, its log in the details. |
| `sdk_unavailable` | The runner isn't configured, busy (`SDK_MAX_CONCURRENT`), refused the call or went away. |
| `timeout` | The block's or query's timeout (the runner stops the jail). |
| `invalid_config` | No setup code, no token, a package line that doesn't parse. |

The runner's own limits: 512 MB (`SDK_MEMORY_MB`; Node's heap is ¾ of it and running out is reported as memory), 64
tasks, 128 MB of `/tmp`, the call's timeout. Each call starts a fresh jail: ~100–300 ms plus the SDK's import.

## Logs and checking

- The runner logs one JSON line per call (`sdk_call`: language, mode, ok, error kind, blocked count, env): never the
  token, the secrets or the arguments. `docker compose logs sdk-runner`.
- The builder logs `build_npm` per JavaScript install (`envId`, cached or not).
- `curl -s http://sdk-runner:8080/health` from the api container: Python's and Node's versions.
- Envs unused for `PYTHON_ENV_KEEP_DAYS` (30) are removed by the builder; the next call installs again.

## Tests

`apps/code-executor/test/sdk-runner.test.ts` and `sdk-packages.test.ts` (the runner and the builder in Docker),
`packages/connectors/test/sdk.test.ts` and `sdk-runner-client.test.ts`, `apps/server/test/sdk-resources.test.ts` (the
real builder and runner), and the e2e `apps/web/e2e/m37-done-when.spec.ts` (`E2E_SDK`: a Python test SDK and a fake
API on the host). `startTestSdkRunner` (`@ow/code-executor/testing`) runs a throwaway runner; `SDK_RUNNER_TEST_URL` and
`SDK_RUNNER_TEST_TOKEN` point the tests at another.
