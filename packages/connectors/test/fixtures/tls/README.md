# TLS fixtures (test only)

A throwaway CA (`ca.crt`; its key was deleted after signing) and a certificate for `api.internal`
(`api.internal.crt`, `api.internal.key`) for M17's REST-over-SSH tests: an HTTPS server behind the test SSH server,
trusted in that test file only through `tls.setDefaultCACertificates`. Made on 2026-10-22 with `openssl`, valid for
20 years.
