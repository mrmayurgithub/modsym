# Security Policy

## Supported versions

Only the latest published release of `modsym` is supported.

If you are not on the latest release, update and re-check before
reporting. Fixes are not backported to older versions, and there is
no LTS release line.

## Reporting a vulnerability

Do not open a public issue for a suspected security vulnerability.

Report privately via GitHub private vulnerability reporting on the
`modsym` repository (Security tab → Report a vulnerability).

## What to include

- The exact package spec and symbol used (e.g. `modsym zod@4.5.4 string`).
- The full JSON output `modsym` produced.
- The `modsym` version (`modsym --version` path or installed version).
- Node.js version and OS.
- A minimal reproduction: the smallest package spec plus symbol that
  triggers the issue, and anything unusual about the environment
  (custom `MODSYM_CACHE`, registry mirror, offline setup).

## What happens next

A maintainer reviews the report, investigates, and follows up through
the private report thread. If a fix is needed, it ships in a future
release and is noted in the release notes. Vulnerabilities are not
discussed publicly until a fix is available.

## Scope note

`modsym` parses published third-party `.d.ts` files from npm packages.
A confusing or incorrect declaration in a third-party package is a
resolution bug, not a `modsym` vulnerability, unless it causes `modsym`
itself to behave insecurely.
