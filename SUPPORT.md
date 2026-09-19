# Support

## Supported use cases

`modsym` resolves a bare exported symbol from an npm package to its
published TypeScript declaration (`.d.ts`, `.d.mts`, `.d.cts`):

```bash
modsym zod@4.5.4 string
modsym <package-spec> --list [--match <text>] [--limit <n>]
```

Exit codes: `0` means a resolution or listing succeeded, `2` means an
intentional abstention (`not_resolved` or `ambiguous`), and `1` means a
usage or operational error. See README for the full behavior contract.

## Non-goals (out of scope)

- Non-npm ecosystems.
- Implementation or runtime source lookup (declarations only).
- Traversal into external-package or `#imports` re-exports.
- Full subpath crawling in list mode (root-scoped only).
- Qualified (`ns.Sym`) or ambient symbol resolution.
- Type checking, language-server behavior, or documentation search.

Requests in these areas will be declined, not queued.

## Reporting an issue

Include the same reproduction info as SECURITY.md: exact package spec,
symbol, full JSON output, `modsym` version, Node/OS, and a minimal
repro. Additionally, note cache freshness: whether `MODSYM_CACHE` is
set, and whether the result persists after clearing or bypassing the
extracted-package cache (`~/.cache/modsym/pkgs` by default).

## Triaging your result

- **Resolution bug:** exit `0` but the declaration (file, line, text)
  is wrong for the requested symbol. Include what the correct
  declaration should be.
- **Unsupported packaging:** exit `2` with a `reason` such as
  `external_reexport`, `no_types`, or `resolution_incomplete`. This is
  truthful abstention per the product contract, not a bug, unless you
  can show the pattern is documented as supported.
- **Operational failure:** exit `1` (fetch, cache, or usage error, one
  line on stderr). Check network access, registry reachability, and
  `MODSYM_CACHE` writability first.

## Node and OS support

The exact supported Node/OS matrix lives in README.md — CI is the
source of truth and this file does not restate it. `package.json`
requires Node `>= 18` via `engines`.
