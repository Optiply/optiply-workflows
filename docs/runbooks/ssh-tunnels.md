# Runbook: SSH tunnels for resources

A Postgres, MySQL or REST resource can reach its database or API through an SSH server (a bastion), and through up to
two jump hosts before it, instead of connecting directly. The tunnel is made by the platform itself, in the process
that runs the query: nobody starts `ssh -L` by hand, and no local port is opened. The design is
`docs/architecture.md` §2.20; this page is for setting one up and keeping it working.

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
- Every request of a tunnelled REST resource goes through it, an OAuth2 client-credentials token included. The
  private-network guard doesn't apply: what's reached is the SSH server's network.

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

## When it fails

Test connection reports each hop, then the database or API. The messages, and what to do:

| Code | Says | What to do |
|---|---|---|
| `ssh_host_key_unknown` | its host key isn't trusted yet | Check the fingerprint (step 4) and trust it. |
| `ssh_host_key_changed` | its host key changed, with the trusted and presented fingerprints | If the server was reinstalled or its host keys replaced, check the new one and trust it. **Otherwise don't**: something may be between the platform and the server. |
| `ssh_auth` | signing in as `user` was refused | The public key isn't in that user's `authorized_keys` (or the password is wrong, or the user doesn't exist). |
| `ssh_connect` | couldn't connect, or didn't answer in time | The host or port, a firewall between the platform and the SSH server. Each hop has 15 s. |
| `ssh_forward` | couldn't open a connection to `host:port` | The SSH server can't reach that host and port, or forwarding is off for the user (`AllowTcpForwarding`, `PermitOpen`). |
| `invalid_config` | a key is missing, unreadable, or its passphrase doesn't open it | Fix it in the settings; saving checks it too. |

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
  server that drops idle connections (`ClientAliveInterval`).
- Log lines (`component: ssh`): `ssh tunnel connected` (info), `ssh tunnel connected again`, `ssh tunnel dropped` and
  `ssh tunnel failed` (warn, with the hop and the code). Servers appear as `user@host:port`.

## Not supported

SSH agents or agent forwarding, SSH certificates (`*-cert-v01@openssh.com`), keyboard-interactive or 2FA logins,
SOCKS or HTTP proxies, and tunnels for BigQuery.
