# Runbook: SSH tunnels for resources

A Postgres, MySQL or REST resource can reach its database or API through an SSH server (a bastion), and through up to
two jump hosts before it, instead of connecting directly. The tunnel is made by the platform itself, in the process
that runs the query: nobody starts `ssh -L` by hand, and no local port is opened. The design is
`docs/architecture.md` §2.20; this page is for setting one up and keeping it working. The SSH server itself can be
reached through **Google Cloud IAP** instead of directly (M18, §2.21; "Through Google Cloud IAP" below).

## How it fits

```
api / worker ──SSH──▶ jump host (optional) ──SSH──▶ SSH server ──TCP──▶ db.internal:5432
               └─ one SSH connection per resource configuration and process, shared by its connection pool ─┘
```

- Settings are **per environment**, in the resource's Settings tab: "Connect through an SSH tunnel".
- Each process (the API, each worker) opens its own tunnel when the resource is first used and keeps it while the
  resource's pool is in use (the pool drops idle clients after 5 minutes). Saving the settings replaces it.
- The database's or API's **host is as the SSH server sees it**: `localhost` means the SSH server itself, and an
  internal name only needs to resolve there. TLS (Postgres `verify-full`, MySQL, https) is checked against that host.
- Every request the REST connector sends for a tunnelled resource goes through it: queries, and an OAuth2
  client-credentials token. **Not** the OAuth2 authorization-code flow (connecting an account, and refreshing its
  token): the server does that directly, so its token endpoint must be reachable from the platform itself. The
  private-network guard doesn't apply to what goes through the tunnel: what's reached is the SSH server's network.

## Setting one up

1. **A key for the platform.** Make one for it alone (not someone's own key):
   ```bash
   ssh-keygen -t ed25519 -C optiply-workflows -f optiply-workflows   # a passphrase is optional
   ```
   OpenSSH, PEM/PKCS#8 and PuTTY `.ppk` (versions 2 and 3, from PuTTYgen) all work; RSA, Ed25519 and ECDSA. DSA keys
   are refused. A password instead of a key works too ("Sign in with: A password").
2. **On the SSH server**, as the user the platform signs in as:
   - add the public key (`optiply-workflows.pub`, or "Copy public key" in the settings once saved) to
     `~/.ssh/authorized_keys`;
   - allow forwarding for that user: `AllowTcpForwarding yes` in `/etc/ssh/sshd_config` (or a `Match User` block),
     and `PermitOpen db.internal:5432` there to allow only what it needs. The user needs no shell
     (`ForceCommand /bin/false` or `nologin` is fine: the platform only forwards).
3. **In the resource's settings** (each environment): the database's host and port as the SSH server sees them, then
   the tunnel: the SSH server's host, port and user, and the private key (paste it or "From a file") with its
   passphrase. Jump hosts go before the server, in the order they're connected to. **Save.**
4. **Trust the host key.** Click **Test connection**: the SSH server shows the host key it presented. Check it with
   whoever runs the server, who can print it with:
   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```
   It must be the same `SHA256:…`. Then **Trust this key** (the test runs again with it), and **Save**. Each jump host
   is trusted the same way, one after another.

**An SSH server on the Docker host** (a `gcloud start-iap-tunnel … --local-host-port=localhost:2222` on your Mac, say):
the API runs in a container, where `localhost` is the container itself. Use `host.docker.internal` (the refused
connection says so). It works only while that command runs: for a VM on Google Cloud, let the platform go through IAP
itself instead.

## Through Google Cloud IAP

For a VM with no public address, reachable only through IAP's TCP forwarding (what `gcloud compute start-iap-tunnel`
does). The platform opens IAP's WebSocket itself, in process; nothing runs on anyone's machine. IAP replaces only the
connection to the **first** SSH server: SSH, its key, its host key and any jump hosts after it stay as above.

```
api / worker ──WSS──▶ tunnel.cloudproxy.app ──TCP──▶ VM:22 ──SSH──▶ (jump host) ──TCP──▶ db.internal:5432
```

1. **The VM**: its project, zone and instance name (`gcloud compute instances list`, or the console), and the SSH port
   on it. A firewall rule must let IAP's range `35.235.240.0/20` reach that port.
2. **A Google identity with the IAP-secured Tunnel User role** (`roles/iap.tunnelResourceAccessor`) on the VM or its
   project. Either:
   - **a service account key** (JSON) kept with the resource, encrypted like every secret; make an account for the
     platform alone:
     ```bash
     gcloud iam service-accounts create optiply-workflows-iap --project PROJECT
     gcloud projects add-iam-policy-binding PROJECT \
       --member serviceAccount:optiply-workflows-iap@PROJECT.iam.gserviceaccount.com \
       --role roles/iap.tunnelResourceAccessor
     gcloud iam service-accounts keys create key.json \
       --iam-account optiply-workflows-iap@PROJECT.iam.gserviceaccount.com
     ```
   - or **this server's own identity**: its Application Default Credentials (Google Sheets and Gemini on Vertex AI
     can use it too: `docs/runbooks/connectors.md`, `docs/runbooks/ai.md`). Off unless the instance opts in
     (`GOOGLE_SERVER_IDENTITY=allow`), and **only admins** can choose it for a resource or point it at another VM
     (editors keep it and change the rest): it may reach VMs no one's key does. Where it comes from, in this order:
     the file `GOOGLE_APPLICATION_CREDENTIALS` names (a service account key or an `authorized_user` file), gcloud's
     `~/.config/gcloud/application_default_credentials.json`, then the metadata server on Google Cloud (the VM's
     service account). **With Docker Compose on a Mac:** `gcloud auth application-default login`, then
     `docker-compose.gcloud.yml` mounts that file read-only and opts in; keep it with
     `COMPOSE_FILE=docker-compose.yml:docker-compose.gcloud.yml` in `.env` (or `-f` both files), and recreate the
     `api` and `worker` containers. The identity is then yours: what you may reach, it may.
3. **In the settings**: the SSH server's "Reach it: Through Google Cloud IAP", the project, zone, instance and port,
   the user and its SSH key as before, and the Google identity (a key, pasted or from a file, shows the account it
   signs in as; the server's identity shows whose it is, or why it has none). **Save.**
4. **Test connection** shows a line for IAP first ("Google Cloud IAP to project/zone/instance:22 · as …"), then the
   SSH server's host key to trust (step 4 above), then the database.

A dropped WebSocket is resumed where it left off (retried for up to 30 s): queries under way carry on. Past that, the
tunnel fails like a dropped SSH connection and is connected again on the next query.

## When it fails

Test connection reports each hop, then the database or API. The messages, and what to do:

| Code | Says | What to do |
|---|---|---|
| `ssh_host_key_unknown` | its host key isn't trusted yet | Check the fingerprint (step 4) and trust it. |
| `ssh_host_key_changed` | its host key changed, with the trusted and presented fingerprints | If the server was reinstalled or its host keys replaced, check the new one and trust it. **Otherwise don't**: something may be between the platform and the server. |
| `ssh_auth` | signing in as `user` was refused | The public key isn't in that user's `authorized_keys` (or the password is wrong, or the user doesn't exist). |
| `ssh_connect` | couldn't connect, or didn't answer in time | The host or port, a firewall between the platform and the SSH server. Each hop has 15 s. |
| `ssh_forward` | couldn't open a connection to `host:port` | The SSH server can't reach that host and port, or forwarding is off for the user (`AllowTcpForwarding`, `PermitOpen`). |
| `invalid_config` | a key is missing, unreadable, or its passphrase doesn't open it; the IAP key isn't a service account key; the server's identity isn't allowed here | Fix it in the settings; saving checks it too. |
| `iap_auth` | Google IAP refused the identity, or no token could be had for it | The identity needs the IAP-secured Tunnel User role on the VM or its project; a key that's been deleted or disabled; for the server's identity, its credentials (an expired `gcloud auth application-default login`: log in again). |
| `iap_target` | Google IAP couldn't find the VM, or couldn't connect to its port | The project, zone and instance name; something listening on that port, and a firewall rule letting `35.235.240.0/20` reach it. |
| `iap_connect` | couldn't reach Google IAP, or it closed the connection | Outbound HTTPS to `tunnel.cloudproxy.app` from the platform; a resume that didn't succeed within 30 s. |

Queries fail with the same messages (code `connection`, details naming the hop). A tunnel that drops (the SSH server
restarts, the network goes) is noticed by keepalives within about 45 s (every 15 s, three missed) and connected again
on the next query; nothing needs restarting.

## Keys and rotation

- Keys, passphrases and passwords are stored encrypted like every resource secret (`ENCRYPTION_KEYS`), write-only:
  the settings show a key's type, fingerprint and public half, never the key. They're never logged; errors are
  scrubbed of them.
- **Rotating the key:** add the new public key to `authorized_keys`, replace the key in the settings (Replace),
  Test connection, Save, then remove the old public key from the server.
- **A new SSH server (or new host keys):** the trusted key no longer matches: Test connection shows both; trust the
  new one after checking it. Changing a hop's host or port forgets its trusted key.

## Watching it

- Metrics (`/metrics`): `ow_ssh_tunnels_open` (tunnels this process has connected now) and
  `ow_ssh_tunnel_reconnects_total` (connected again after a drop). Many reconnects: an unstable network or an SSH
  server that drops idle connections (`ClientAliveInterval`). `ow_iap_resumes_total`: IAP WebSockets resumed after
  they dropped (M18).
- Log lines (`component: ssh`): `ssh tunnel connected` (info), `ssh tunnel connected again`, `ssh tunnel dropped` and
  `ssh tunnel failed` (warn, with the hop and the code). Servers appear as `user@host:port`.

## Not supported

SSH agents or agent forwarding, SSH certificates (`*-cert-v01@openssh.com`), keyboard-interactive or 2FA logins,
SOCKS or HTTP proxies, and tunnels for BigQuery. Through IAP: only the first SSH server, a VM by name (not IAP
destination groups or an on-premises host), and no impersonation of another service account.
