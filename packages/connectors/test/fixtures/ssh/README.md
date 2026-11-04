# SSH key fixtures (test keys only)

Throwaway keys for `packages/connectors` tests (M17): they grant access to nothing. Made on 2026-10-22 with
OpenSSH's `ssh-keygen` (macOS) and PuTTY's `puttygen` 0.78 (Debian bookworm's `putty-tools`, in Docker). The
passphrase of every encrypted one is `fixture pass`.

- `openssh-*`: `ssh-keygen -t <type> [-b <bits>] -N <passphrase or ''> -C fixture-<type>`; `*.pub` is each public half.
- `pem-*`: the same with `-m PEM` (`BEGIN RSA PRIVATE KEY`, `BEGIN EC PRIVATE KEY`).
- `ppk2-*`, `ppk3-*`: `puttygen <openssh key> -O private --ppk-param version=<2|3>[,kdf=argon2id|argon2i|argon2d]
  [--new-passphrase <file>]`, from the OpenSSH key of the same type, so a `.ppk` and its `openssh-*.pub` share a
  public half: `ppk2-rsa*` and `ppk3-rsa-encrypted` from `openssh-rsa`, `*-ed25519*` from `openssh-ed25519`,
  `ppk3-ecdsa256` from `openssh-ecdsa256`, `ppk3-ecdsa384-encrypted` from `openssh-ecdsa384`.
