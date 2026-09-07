# AGENTS.md

## What this repository is

`modsym` is a small CLI for coding agents and developer tooling.

```bash
modsym <npm-package-spec> <symbol>
```

It resolves a bare exported symbol from an npm package to its published TypeScript declaration by following the package's declaration/export graph.

The primary output is bounded, deterministic JSON.

## Core invariant

**Prefer abstention over an incorrect resolution.**

`ambiguous` and `not_resolved` are valid outcomes.

A confident wrong declaration is a regression even if overall resolution coverage increases.

## v0.1 scope

Supported:

- npm packages
- `.d.ts`, `.d.mts`, `.d.cts`
- package `types` / `typings` / `exports`
- relative and self-package re-exports
- barrels, aliases, renames, default aliases
- import-traced and same-file exports
- bounded ambiguity handling

Intentionally unsupported:

- implementation/source lookup
- external-package traversal
- qualified or ambient symbol resolution
- TypeScript `Program` / type checking / language-server behavior
- MCP/server functionality
- package search/browsing
- non-npm ecosystems

Do not expand this scope incidentally while fixing another issue.

## Architecture

Main responsibilities live under `src/`:

- `spec` — package spec parsing
- `acquire` — package acquisition/cache
- `entry` — declaration entry discovery
- `graph` — declaration/export traversal
- `parse` — TypeScript AST parsing
- `resolve` — symbol resolution
- `serialize` — bounded deterministic output
- `cli` — CLI behavior

TypeScript is used as a parser via `createSourceFile`, not as a project/type-checking engine.

## Development

Run:

```bash
npm test
```

Before release-sensitive changes also verify:

```bash
npm pack --dry-run
```

Useful manual smoke tests:

```bash
modsym zod@4.5.4 string
modsym @ai-sdk/openai@4.0.60 createOpenAI
modsym semver satisfies
```

## When changing resolution logic

Add or update a focused fixture reproducing the packaging pattern.

Check for:

1. correct declaration
2. no new false positives
3. deterministic output
4. bounded output
5. truthful abstention when unsupported

Avoid broad refactors unless they are required for correctness.

## Product philosophy

`modsym` is deliberately a small primitive.

Do not add features merely because they are adjacent or easy. New capabilities should be justified by real agent workflows and evidence that existing tools are insufficient.
