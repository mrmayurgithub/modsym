# modsym

A small CLI that resolves an exported symbol from an npm package to its published TypeScript declaration, without manually chasing package re-exports, barrels, aliases, and `.d.ts` files.

```bash
modsym zod@4.5.4 string
```

```json
{
  "status": "resolved",
  "package": "zod",
  "version": "4.5.4",
  "symbol": "string",
  "declaration": {
    "file": "v4/classic/schemas.d.cts",
    "line": 171,
    "kind": "function",
    "text": "export declare function string(params?: string | core.$ZodStringParams): ZodString;"
  },
  "resolutionChain": [".", "./v4/classic/external.cjs", "./schemas.cjs"]
}
```

```bash
modsym @ai-sdk/openai@4.0.60 createOpenAI
```

## Who this is for

`modsym` is primarily a small primitive for coding agents and agentic developer tooling that need to inspect an unfamiliar npm API. It is also usable directly from a terminal, but it is not a general npm inspection tool.

Route an investigation to `modsym` when the question is which published
TypeScript declaration backs an unfamiliar, export-heavy npm API. Skip it for
implementation or runtime investigation, flat declarations, compiler-guided
fixes, documentation lookup, qualified or ambient symbols, and untyped
packages.

## Find which `.d.ts` file defines an exported npm package symbol

When an agent needs the exact declaration behind an unfamiliar export — the file and line an IDE's 'go to definition' would land on — the manual path is sometimes:

```text
package.json
→ exports
→ declaration entry
→ barrel
→ re-export
→ alias
→ actual .d.ts declaration
```

That can take several `rg`, `find`, `npm`, and file-reading calls — not on every task, but often enough on export-heavy packages to matter. `modsym` provides one bounded primitive for that specific lookup.

## How it works

1. Resolves the requested package/version with npm-compatible tooling (`pacote`; accepts bare names, `name@version`, ranges, dist-tags, local `file:` paths).
2. Discovers the package's published declaration entry points from `package.json` (`exports.types`, `types`/`typings`, related conditions).
3. Follows the package's TypeScript export/re-export graph, including relative and self-package re-exports (barrels, `export *`, named re-exports, same-file aliases).
4. Parses candidate files with the TypeScript compiler as a syntax parser (per-file AST via `createSourceFile`; no `Program`, no type checker, no language server) to identify the exported declaration.
5. Resolves the bare symbol to its unique declaration and returns bounded deterministic JSON (text and chains are length-capped).
6. Abstains with a machine-readable reason instead of guessing when the symbol is unsupported or ambiguous.

This makes it more than a grep wrapper — it understands export structure — without running type checking or a server.

## Install and use

```bash
npm install -g modsym
modsym zod@4.5.4 string
```

Or without installing:

```bash
npx modsym zod@4.5.4 string
```

Usage:

```bash
modsym <package-spec> <symbol>
modsym <package-spec> --list [--match <text>] [--limit <n>]
```

Normal resolve and `--list` commands emit deterministic JSON on stdout. `--help`
and `--version` are informational text commands. Exit code `0` means a
resolution or listing succeeded, `2` means an intentional abstention
(`not_resolved` or `ambiguous`), and `1` means a usage or operational error
(one line on stderr, no stack traces). No colors, no interaction, no extra
logging.

For registry packages, the extracted package cache defaults to
`~/.cache/modsym/pkgs` (or `$XDG_CACHE_HOME/modsym/pkgs` when
`XDG_CACHE_HOME` is set). `MODSYM_CACHE` replaces that extracted-package cache
directory. On a cold cache, modsym resolves registry manifest metadata and
then downloads and extracts the package. On a warm cache, it still resolves
the manifest first, then reuses a matching extracted package. Therefore a warm
extracted cache does not guarantee fully offline operation: registry metadata
resolution may still require network access. Local `file:` directory package
specs can be used without registry access. Nothing is written to your working
directory.

When an agent does not know the exact exported symbol yet, list the package's
root declaration API surface:

```bash
modsym zod@4.5.4 --list
modsym pino --list --match log
```

`--list` is intentionally root-scoped: it follows the package's root
declaration entry and root-visible barrels/re-exports, but it does not crawl
every exported subpath. `--match` is a deterministic case-insensitive substring
match against symbol names only; it is not fuzzy, semantic, or documentation
search. Filtering happens before truncation. List output defaults to 100 shown
exports and accepts `--limit <n>` up to a hard maximum of 500.

```json
{
  "status": "listed",
  "package": "zod",
  "version": "4.5.4",
  "scope": "root",
  "match": null,
  "exports": [
    {
      "name": "$brand"
    }
  ],
  "total": 298,
  "shown": 1,
  "truncated": true,
  "filesVisited": 7
}
```

Each listed export always has a `name`. `kind`, `file`, and `line` appear only
when they are cheaply and confidently available from the listing walk. Use
`modsym <package-spec> <symbol>` after discovery for the exact declaration.
If a traversal limit, read failure, or unresolved relative/self-package
`export *` edge prevents a complete walk, list mode returns
`status: "not_resolved"` with `reason: "resolution_incomplete"` and exit code
`2`; it does not return a partial export list or an incomplete `total` as
successful output.

## Output contract

- `status`: `resolved` | `ambiguous` | `not_resolved` | `listed` — all are intentional outcomes.
- `package` / `version` / `symbol`: what was resolved.
- `declaration`: file, line, kind, signature text, and export condition (only when `resolved`).
- `resolutionChain`: export subpaths followed (only when `resolved`).
- `reason` / `candidates`: why resolution stopped, or a bounded candidate list (when `ambiguous` / `not_resolved`).
- `exports` / `total` / `shown` / `truncated`: bounded root export discovery results (only when `listed`).

`modsym` prefers an explicit abstention over returning a declaration it cannot resolve confidently. That is part of the product contract, not just a limitation:

```bash
modsym semver satisfies
```

```json
{
  "status": "not_resolved",
  "package": "semver",
  "version": "7.8.5",
  "symbol": "satisfies",
  "reason": "no_types"
}
```

Other reasons include `resolution_incomplete`, `external_reexport`,
`ambient_module`, `qualified_only`, `unsupported_export_form`, `default_only`,
and `not_found`.

`resolution_incomplete` means modsym found an incomplete declaration-graph
walk and therefore did not assert a result. This includes traversal limits,
read failures, and unexamined `export *` edges whose relative/self-package
target could not be resolved or whose external-package/`#imports` target is
intentionally not traversed. In list mode, no partial export list or `total`
is returned when completeness is not established.

Subpath fallback is deliberately package-wide and conservative: if any visited
subpath leaves the declaration walk incomplete, modsym abstains even when a
different subpath contains the only otherwise-resolved declaration. This keeps
fallback resolution from asserting uniqueness it has not fully checked.

## Scope

Supports bare exported TypeScript symbols in npm packages, including direct exports, barrels, `export *`, named re-exports, and same-file aliases.

Explicitly out of scope:

- npm only (no other ecosystems)
- declaration resolution only — no implementati