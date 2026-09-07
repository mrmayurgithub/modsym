import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile } from './parse.js';
import { pickEntryDts, pickSubpathTypes } from './entry.js';
import {
  createTraversal,
  resolveFile,
  selfSubpathRel,
  isRelativeSpecifier,
  isBareSpecifier,
  flavorOf,
  countDeclFiles,
} from './graph.js';

const MAX_CANDIDATES = 10;
const MAX_BARREL_FANOUT = 50;

/**
 * Resolve a bare symbol against an extracted package directory.
 *
 * Traces `symbol` from the root declaration entry (or entries) through
 * the export/re-export graph by breadth-first search. Local renames are
 * tracked (`seek` follows `export {A as B}` to `A`), `export * as ns`
 * branches are never followed for bare lookups, and only declaration
 * files are ever visited.
 *
 * Returns an internal result; see serialize.js for the public schema.
 * Never throws for resolution outcomes — only for unreadable inputs.
 */
export function resolveIn(root, symbol) {
  const pkgJson = readPackageJson(root);
  const traversal = createTraversal();
  const { queue } = traversal;
  const signals = {
    external: [],
    defaultOnly: false,
    ambientEntry: false,
    unsupportedForm: false,
    symbolSeen: false,
    entryFiles: [],
  };

  for (const entry of pickEntryDts(pkgJson)) {
    const file = resolveFile(path.join(root, 'package.json'), entry.rel);
    if (file && traversal.enqueue(file, ['.'], symbol, entry.condition)) {
      signals.entryFiles.push(file);
    }
  }
  if (queue.length === 0) {
    return {
      status: 'not-resolved',
      reason: 'no_types',
      ...(countDeclFiles(root) === 0 ? {} : { note: 'no-resolvable-entry' }),
      filesVisited: 0,
    };
  }

  const ctx = { root, pkgJson, symbol, traversal, signals };
  while (queue.length > 0) {
    const item = queue.shift();
    const hit = processOne(ctx, item);
    if (hit) return hit;
  }

  const subpathHit = searchSubpaths(ctx);
  if (subpathHit) return subpathHit;
  return abstain(ctx);
}

function readPackageJson(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through
  }
  return {};
}

/**
 * Resolve a specifier found in `file`. Relative specifiers resolve to
 * sibling declarations; the package's own name resolves through its
 * `exports` map (self-package re-exports); anything else is external
 * and out of scope (recorded for abstention reasons when relevant).
 */
function resolveDep(ctx, file, spec, hooks = {}) {
  if (!spec || spec.startsWith('#')) return null;
  if (isRelativeSpecifier(spec)) return resolveFile(file, spec);
  // Self-package re-exports (`export * from "zustand/vanilla"` inside zustand):
  // resolve through the package's own exports map.
  const pkgName = ctx.pkgJson.name;
  if (pkgName && (spec === pkgName || spec.startsWith(`${pkgName}/`))) {
    const subpath = spec === pkgName ? '.' : `./${spec.slice(pkgName.length + 1)}`;
    const rel = selfSubpathRel(ctx.pkgJson, subpath);
    if (rel) {
      const abs = resolveFile(path.join(ctx.root, 'package.json'), rel);
      if (abs) return abs;
    }
    if (hooks.onSelf) hooks.onSelf(spec);
    return null;
  }
  if (hooks.onExternal) hooks.onExternal(spec);
  return null;
}

function processOne(ctx, item) {
  const { root, symbol, traversal, signals } = ctx;
  const { file, chain, seek, cond } = item;
  let parsed;
  try {
    parsed = analyzeFile(file, readUtf8);
  } catch {
    return null;
  }
  const rel = path.relative(root, file);
  const resolved = (decls, via, method) => ({
    status: 'resolved',
    symbol,
    decl: {
      file: rel,
      line: decls[0].line,
      kind: decls[0].kind,
      overloads: decls.length,
      text: decls[0].text,
      chain,
      via,
      condition: cond,
      flavor: flavorOf(file),
    },
    filesVisited: traversal.visitedCount,
    method,
  });

  // 1. Direct exported declaration (overloads preserved as multiple records).
  if (parsed.local.has(seek)) {
    return resolved(parsed.local.get(seek), undefined, 'ts-ast-direct');
  }

  // 2. Seeking `default`: inline `export default class/function X`, or
  // `export default X` where X is declared in this file.
  if (seek === 'default') {
    if (parsed.defaults.length > 0) {
      return resolved(
        parsed.defaults.map(d => d.rec),
        'export default',
        'ts-ast-default',
      );
    }
    if (
      parsed.exportDefault &&
      (parsed.local.has(parsed.exportDefault) || parsed.pendingLocal.has(parsed.exportDefault))
    ) {
      const decls = parsed.local.get(parsed.exportDefault) || parsed.pendingLocal.get(parsed.exportDefault);
      return resolved(decls, `export default ${parsed.exportDefault}`, 'ts-ast-default');
    }
  }

  // 3. Same-file `export {local as seek}` (bundled declarations alias locals).
  // When `local` is itself imported (`export { tool as toolkit }`), follow
  // the import exactly like step 4 below.
  const sameFile = parsed.named.filter(n => n.exported === seek && n.src === null);
  if (sameFile.length > 0) {
    const localName = sameFile[0].local;
    const decls = parsed.local.get(localName) || parsed.pendingLocal.get(localName);
    if (decls) {
      return resolved(decls, `export {${localName} as ${seek}}`, 'ts-ast-same-file-alias');
    }
    const localImport = parsed.imports.get(localName);
    if (localImport && isRelativeSpecifier(localImport.src)) {
      if (localImport.imported === '*') {
        const target = resolveDep(ctx, file, localImport.src);
        if (target) {
          return namespaceHit(ctx, target, seek, chain, cond, localImport.src, `${localImport.src} (import * as ${localName})`);
        }
      } else {
        traversal.enqueue(
          resolveDep(ctx, file, localImport.src),
          [...chain, `${localImport.src} (import ${localImport.imported} as ${localName})`],
          localImport.imported === 'default' ? seek : localImport.imported,
          cond,
        );
      }
    }
  }
  if (parsed.named.some(n => n.src === null && n.local === seek && n.exported === 'default')) {
    signals.defaultOnly = true;
  }

  // 4. Same-file `export {seek}` of an imported symbol: follow the import.
  // Covers named, default, and namespace (`import * as z`) imports.
  if (parsed.named.some(n => n.exported === seek && n.src === null)) {
    const imp = parsed.imports.get(seek);
    if (imp && isRelativeSpecifier(imp.src)) {
      if (imp.imported === '*') {
        const target = resolveDep(ctx, file, imp.src);
        if (target) {
          return namespaceHit(ctx, target, seek, chain, cond, imp.src, `${imp.src} (import * as ${seek})`);
        }
      } else {
        traversal.enqueue(
          resolveDep(ctx, file, imp.src),
          [...chain, `${imp.src} (import ${imp.imported})`],
          imp.imported === 'default' ? seek : imp.imported,
          cond,
        );
      }
    } else if (imp && isBareSpecifier(imp.src)) {
      signals.external.push({ name: seek, src: imp.src });
    }
  }

  // 5. `export = seek` / `export default seek` with an in-file declaration.
  const defaultVia =
    parsed.exportEq === seek ? 'export =' : parsed.exportDefault === seek ? 'export default' : null;
  if (defaultVia && (parsed.pendingLocal.has(seek) || parsed.local.has(seek))) {
    const decls = parsed.pendingLocal.get(seek) || parsed.local.get(seek);
    return resolved(decls, defaultVia, 'ts-ast-export-eq');
  }

  collectSignals(ctx, signals, file, parsed, seek);

  // 6. Named re-exports: follow only edges that export the sought name,
  // tracking renames (`export {A as B}` continues the search as `A`).
  for (const edge of parsed.named.filter(n => n.exported === seek && n.src)) {
    const target = resolveDep(ctx, file, edge.src, {
      onExternal: src => signals.external.push({ name: seek, src }),
    });
    if (target) {
      traversal.enqueue(target, [...chain, `${edge.src} (${edge.local} as ${edge.exported})`], edge.local, cond);
    }
  }

  // 7. Star re-exports (namespace stars were excluded at parse time).
  for (const src of parsed.stars) {
    const target = resolveDep(ctx, file, src);
    if (target) traversal.enqueue(target, [...chain, src], seek, cond);
  }
  return null;
}

function namespaceHit(ctx, target, seek, chain, cond, src, edgeLabel) {
  return {
    status: 'resolved',
    symbol: ctx.symbol,
    decl: {
      file: path.relative(ctx.root, target),
      line: 1,
      kind: 'namespace',
      overloads: 1,
      text: `namespace ${seek} (re-exported from ${src})`,
      chain: [...chain, edgeLabel],
      via: 'namespace-re-export',
      condition: cond,
      flavor: flavorOf(target),
    },
    filesVisited: ctx.traversal.visitedCount,
    method: 'ts-ast-namespace-alias',
  };
}

function collectSignals(ctx, signals, file, parsed, seek) {
  if (!signals.ambientEntry && signals.entryFiles.includes(file) && /declare\s+module\s+['"]/.test(parsed.sf.text)) {
    signals.ambientEntry = true;
  }
  if (!signals.unsupportedForm && /export\s+import\s+\w+\s*=/.test(parsed.sf.text)) {
    signals.unsupportedForm = true;
  }
  if (!signals.symbolSeen) {
    const word = wordPattern(seek);
    if (word && word.test(parsed.sf.text)) signals.symbolSeen = true;
  }
}

function wordPattern(name) {
  try {
    return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  } catch {
    return null;
  }
}

/**
 * Phase 2: search every subpath's declaration entry when the root graph
 * has no answer (e.g. one-symbol-per-file packages). Collects up to
 * MAX_CANDIDATES distinct hits: exactly one resolves, several mean the
 * bare symbol is genuinely ambiguous.
 */
function searchSubpaths(ctx) {
  const { pkgJson, traversal, symbol } = ctx;
  const exportsMap = pkgJson.exports;
  if (!exportsMap || typeof exportsMap !== 'object') return null;
  for (const [subpath, value] of Object.entries(exportsMap)) {
    if (traversal.visitedCount >= 800) break;
    if (subpath === '.' || subpath === './package.json' || subpath.includes('*')) continue;
    const rel = pickSubpathTypes(value);
    if (typeof rel !== 'string') continue;
    traversal.enqueue(
      resolveFileSafe(ctx, rel),
      [subpath],
      symbol,
      `exports["${subpath}"]`,
    );
  }
  const candidates = [];
  const seen = new Set();
  const { queue } = traversal;
  while (queue.length > 0 && candidates.length < MAX_CANDIDATES) {
    const before = queue.length;
    const item = queue.shift();
    const hit = processOne(ctx, item);
    if (hit && hit.status === 'resolved') {
      const key = hit.decl.file.replace(/\.d\.(m|c)?ts$/, '');
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({
          file: hit.decl.file,
          line: hit.decl.line,
          kind: hit.decl.kind,
          text: (hit.decl.text || '').slice(0, 200),
          chain: hit.decl.chain,
          condition: hit.decl.condition,
          flavor: hit.decl.flavor,
        });
      }
    }
    if (queue.length - before > MAX_BARREL_FANOUT) break;
  }
  if (candidates.length === 1) {
    return {
      status: 'resolved',
      symbol,
      decl: { ...candidates[0], totalLines: 0 },
      filesVisited: traversal.visitedCount,
      viaSubpath: true,
      method: 'ts-ast-subpath',
    };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      symbol,
      reason: 'ambiguous',
      candidates,
      filesVisited: traversal.visitedCount,
    };
  }
  return null;
}

function resolveFileSafe(ctx, rel) {
  try {
    return resolveFile(path.join(ctx.root, 'package.json'), rel);
  } catch {
    return null;
  }
}

function abstain(ctx) {
  const { symbol, signals, traversal, root } = ctx;
  const external = signals.external.find(e => e.name === symbol) || signals.external[0];
  let reason = 'not_found';
  if (external && external.name === symbol) reason = 'external_reexport';
  else if (signals.defaultOnly) reason = 'default_only';
  else if (signals.ambientEntry) reason = 'ambient_module';
  else if (signals.unsupportedForm) reason = 'unsupported_export_form';
  else if (signals.symbolSeen) reason = 'qualified_only';
  else if (countDeclFiles(root) === 0) reason = 'no_types';
  const out = { status: 'not-resolved', symbol, reason, filesVisited: traversal.visitedCount };
  if (external) out.external = external;
  return out;
}

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}
