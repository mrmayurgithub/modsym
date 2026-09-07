# modsym

A small deterministic shortcut for resolving an npm package symbol to its published TypeScript declaration, without manually chasing exports and `.d.ts` files.

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

## The problem

When an agent needs the exact declaration of an unfamiliar export, the manual path is sometimes:

```text
package.json
→ exports
→ declaration entry
→ barrel
→ re-export
→ alias
→ actual .d.ts declaration
```

That can take several `rg`, `find`, `npm`, and file-reading calls — not on every task, but often enough on export-heavy packages to matter. `modsym` provides one bounded primitive for that specific operation.

## How it works

1. Resolves the requested package/version with npm-compatible tooling (`pacote`; accepts bare names, `name@version`, ranges, dist-tags, local `file:` paths).
2. Discovers the package's published declaration entry points from `package.json` (`exports.types`, `types`/`typings`, related conditions).
3. Follows the package's TypeScript export/re-export graph (barrels, `export *`, named re-exports, same-file aliases).
4. Uses the TypeScript compiler as a syntax parser (per-file AST; no `Program`, no type checker, no language server) to identify the exported declaration.
5. Returns bounded deterministic JSON (text and chains are length-capped).
6. Abstains instead of guessing when resolution is unsupported or ambiguous.

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
```

JSON always goes to stdout. Exit code `0` when resolved, `2` for `not_resolved` / `ambiguous`, `1` for usage or operational errors (one line on stderr, no stack traces). No colors, no interaction, no extra logging. Packages are fetched into a content-addressed cache (`~/.cache/modsym`, overridable via `MODSYM_CACHE`); nothing is written to your working directory.

## Output contract

- `status`: `resolved` | `ambiguous` | `not_resolved` — all three are intentional outcomes.
- `package` / `version` / `symbol`: what was resolved.
- `declaration`: file, line, kind, signature text, and export condition (only when `resolved`).
- `resolutionChain`: export subpaths followed (only when `resolved`).
- `reason` / `candidates`: why resolution stopped, or a bounded candidate list (when `ambiguous` / `not_resolved`).

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

Other reasons include `external_reexport`, `ambient_module`, `qualified_only`, `unsupported_export_form`, `default_only`, and `not_found`.

## Scope (v0.1)

Supports bare exported TypeScript symbols in npm packages, including direct exports, barrels, `export *`, named re-exports, and same-file aliases.

Explicitly out of scope:

- npm only (no other ecosystems)
- declaration resolution only — no implementation/source lookup
- no external-package re-export traversal
- no qualified (`ns.Sym`) or ambient symbol resolution
- may truthfully return `not_resolved` or `ambiguous`

A wrong confident answer is treated as strictly worse than abstention.

## Benchmark note

In a small 12-task A/B check, agents with `modsym` solved all tasks correctly and used far less inspection output on a few export-heavy cases, with no overall median-call reduction since many trivial tasks needed no inspection at all. Details, including negative findings, are in [`docs/benchmark.md`](docs/benchmark.md).

## Development

```bash
npm install
npm test
```
