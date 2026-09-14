import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile } from './parse.js';
import { pickEntryDts, pickSubpathTypes } from './entry.js';
import {
  createTraversal,
  resolveDependency,
  resolveFile,
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
    if (file && traversal.enqueue(file, ['.'], symbol, entry.condition, {
      fromStar: false,
      entryId: entry.rel,
      fromExplicitNamed: false,
    })) {
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
  const starHits = [];
  const deferredConcreteHits = [];
  while (queue.length > 0) {
    const item = queue.shift();
    const hit = processOne(ctx, item);
    if (hit) {
      if (hit.fromStar) {
        collectStarHit(starHits, hit);
      } else if (hit.method !== 'ts-ast-namespace-alias' || hit.deferForSiblingChecks) {
        // Root entries and named re-export branches can be queued alongside
        // this concrete hit. Defer until all of them have had a chance to
        // produce the same bare symbol; queue order must not choose a winner.
        collectStarHit(deferredConcreteHits, hit);
      } else {
        return traversal.complete ? hit : resolutionIncomplete(ctx);
      }
    }
  }
  if (deferredConcreteHits.length > 0) {
    if (!traversal.complete) return resolutionIncomplete(ctx);
    const competingStars = starHits.filter(star => !deferredConcreteHits.some(hit =>
      hit.fromExplicitNamed && hit.entryId === star.entryId,
    ));
    const allHits = [...deferredConcreteHits, ...competingStars];
    const signatures = new Set(allHits.map(signatureKey));
    if (signatures.size > 1) {
      return {
        status: 'ambiguous',
        symbol,
        reason: 'ambiguous',
        candidates: allHits.slice(0, MAX_CANDIDATES).map(hitToCandidate),
        filesVisited: traversal.visitedCount,
      };
    }
    return stripInternalHit(deferredConcreteHits[0]);
  }
  if (starHits.length > 1) {
    return {
      status: 'ambiguous',
      symbol,
      reason: 'ambiguous',
      candidates: starHits.map(hitToCandidate),
      filesVisited: traversal.visitedCount,
    };
  }
  if (starHits.length === 1) {
    return traversal.complete ? stripStarHit(starHits[0]) : resolutionIncomplete(ctx);
  }

  const subpathHit = searchSubpaths(ctx);
  if (subpathHit) return subpathHit;
  if (!traversal.complete) return resolutionIncomplete(ctx);
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

function resolveDep(ctx, file, spec, hooks = {}) {
  return resolveDependency(ctx.root, ctx.pkgJson, file, spec, hooks);
}

function resolveNamedReexport(ctx, file, edge, seek) {
  let external = false;
  return resolveDep(ctx, file, edge.src, {
    onExternal: src => {
      external = true;
      ctx.signals.external.push({ name: seek, src });
    },
    onUnresolved: () => {
      if (!external) ctx.traversal.markIncomplete();
    },
  });
}

function processOne(ctx, item) {
  const { root, symbol, traversal, signals } = ctx;
  const { file, chain, seek, cond, fromStar = false, entryId, fromExplicitNamed = false } = item;
  let parsed;
  try {
    parsed = analyzeFile(file, readUtf8);
  } catch {
    traversal.markIncomplete();
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
    fromStar,
    entryId,
    fromExplicitNamed,
  });
  let directHit = null;

  // 1. Direct exported declaration (overloads preserved as multiple records).
  if (parsed.local.has(seek)) {
    directHit = resolved(parsed.local.get(seek), undefined, 'ts-ast-direct');
  }

  // 2. Seeking `default`: inline `export default class/function X`, or
  // `export default X` where X is declared in this file.
  if (!directHit && seek === 'default') {
    if (parsed.defaults.length > 0) {
      directHit = resolved(
        parsed.defaults.map(d => d.rec),
        'export default',
        'ts-ast-default',
      );
    } else if (
      parsed.exportDefault &&
      (parsed.local.has(parsed.exportDefault) || parsed.pendingLocal.has(parsed.exportDefault))
    ) {
      const decls = parsed.local.get(parsed.exportDefault) || parsed.pendingLocal.get(parsed.exportDefault);
      directHit = resolved(decls, `export default ${parsed.exportDefault}`, 'ts-ast-default');
    }
  }

  // 3. Same-file `export {local as seek}` (bundled declarations alias locals).
  // When `local` is itself imported (`export { tool as toolkit }`), follow
  // the import exactly like step 4 below.
  const sameFile = parsed.named.filter(n => n.exported === seek && n.src === null);
  if (!directHit && sameFile.length > 0) {
    const localName = sameFile[0].local;
    const decls = parsed.local.get(localName) || parsed.pendingLocal.get(localName);
    if (decls) {
      directHit = resolved(decls, `export {${localName} as ${seek}}`, 'ts-ast-same-file-alias');
    } else {
      const localImport = parsed.imports.get(localName);
      if (localImport && isRelativeSpecifier(localImport.src)) {
        if (localImport.imported === '*') {
          const target = resolveDep(ctx, file, localImport.src);
          if (target) {
            const hit = namespaceHit(ctx, target, seek, chain, cond, localImport.src, `${localImport.src} (import * as ${localName})`, fromStar, entryId, fromExplicitNamed);
            probeDirectHitEdges(ctx, file, parsed, seek, chain, cond, entryId, fromExplicitNamed);
            hit.deferForSiblingChecks = true;
            return hit;
          }
        } else {
          traversal.enqueue(
            resolveDep(ctx, file, localImport.src),
            [...chain, `${localImport.src} (import ${localImport.imported} as ${localName})`],
            localImport.imported === 'default' ? seek : localImport.imported,
            cond,
            { fromStar, entryId, fromExplicitNamed },
          );
        }
      }
    }
  }
  if (parsed.named.some(n => n.src === null && n.local === seek && n.exported === 'default')) {
    signals.defaultOnly = true;
  }
  if (directHit) {
    collectSignals(ctx, signals, file, parsed, seek);
    probeDirectHitEdges(ctx, file, parsed, seek, chain, cond, entryId, fromExplicitNamed);
    return directHit;
  }

  // 4. Same-file `export {seek}` of an imported symbol: follow the import.
  // Covers named, default, and namespace (`import * as z`) imports.
  if (parsed.named.some(n => n.exported === seek && n.src === null)) {
    const imp = parsed.imports.get(seek);
    if (imp && isRelativeSpecifier(imp.src)) {
      if (imp.imported === '*') {
        const target = resolveDep(ctx, file, imp.src);
        if (target) {
          const hit = namespaceHit(ctx, target, seek, chain, cond, imp.src, `${imp.src} (import * as ${seek})`, fromStar, entryId, fromExplicitNamed);
          probeDirectHitEdges(ctx, file, parsed, seek, chain, cond, entryId, fromExplicitNamed);
          hit.deferForSiblingChecks = true;
          return hit;
        }
      } else {
        traversal.enqueue(
          resolveDep(ctx, file, imp.src),
          [...chain, `${imp.src} (import ${imp.imported})`],
          imp.imported === 'default' ? seek : imp.imported,
          cond,
          { fromStar, entryId, fromExplicitNamed },
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
  let explicitLocalReexport = false;
  for (const edge of parsed.named.filter(n => n.exported === seek && n.src)) {
    const target = resolveNamedReexport(ctx, file, edge, seek);
    if (target) {
      explicitLocalReexport = true;
      traversal.enqueue(target, [...chain, `${edge.src} (${edge.local} as ${edge.exported})`], edge.local, cond, {
        fromStar,
        entryId,
        fromExplicitNamed: !fromStar,
      });
    }
  }

  // 7. Star re-exports (namespace stars were excluded at parse time).
  for (const src of parsed.stars) {
    const target = resolveDep(ctx, file, src, {
      onUnresolved: () => {
        if (!explicitLocalReexport) traversal.markIncomplete();
      },
    });
    if (target) traversal.enqueue(target, [...chain, src], seek, cond, {
      fromStar: true,
      entryId,
      fromExplicitNamed,
    });
  }
  return null;
}

function probeDirectHitEdges(ctx, file, parsed, seek, chain, cond, entryId, fromExplicitNamed) {
  const { traversal } = ctx;
  for (const edge of parsed.named.filter(n => n.exported === seek && n.src)) {
    resolveNamedReexport(ctx, file, edge, seek);
  }
  let enqueuedStarSibling = false;
  for (const src of parsed.stars) {
    const target = resolveDep(ctx, file, src, {
      onUnresolved: () => traversal.markIncomplete(),
    });
    if (target && traversal.enqueue(target, [...chain, src], seek, cond, {
      fromStar: true,
      entryId,
      fromExplicitNamed,
    })) {
      enqueuedStarSibling = true;
    }
  }
  return enqueuedStarSibling;
}

function collectStarHit(hits, hit) {
  const key = `${hit.decl.file}:${hit.decl.line}:${hit.decl.kind}:${hit.decl.text}`;
  if (!hits.some(existing => `${existing.decl.file}:${existing.decl.line}:${existing.decl.kind}:${existing.decl.text}` === key)) {
    hits.push(hit);
  }
}

function stripStarHit(hit) {
  return stripInternalHit(hit);
}

function stripInternalHit(hit) {
  const { fromStar, entryId, fromExplicitNamed, deferForSiblingChecks, ...rest } = hit;
  return rest;
}

function signatureKey(hit) {
  return `${hit.decl.kind}:${hit.decl.overloads}:${hit.decl.text}`;
}

function hitToCandidate(hit) {
  return {
    file: hit.decl.file,
    line: hit.decl.line,
    kind: hit.decl.kind,
    text: (hit.decl.text || '').slice(0, 200),
    chain: hit.decl.chain,
    condition: hit.decl.condition,
    flavor: hit.decl.flavor,
  };
}

function namespaceHit(ctx, target, seek, chain, cond, src, edgeLabel, fromStar = false, entryId, fromExplicitNamed = false) {
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
    fromStar,
    entryId,
    fromExplicitNamed,
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
    if (traversal.visitedCount >= 800) {
      traversal.markIncomplete();
      break;
    }
    if (subpath === '.' || subpath === './package.json' || subpath.includes('*')) continue;
    const rel = pickSubpathTypes(value);
    if (typeof rel !== 'string') continue;
    traversal.enqueue(
      resolveFileSafe(ctx, rel),
      [subpath],
      symbol,
      `exports["${subpath}"]`,
      { fromStar: false },
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
    if (queue.length - before > MAX_BARREL_FANOUT) {
      traversal.markIncomplete();
      break;
    }
  }
  if (candidates.length === 1) {
    if (!traversal.complete) return resolutionIncomplete(ctx);
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
    ctx.traversal.markIncomplete();
    return null;
  }
}

function resolutionIncomplete(ctx) {
  return {
    status: 'not-resolved',
    symbol: ctx.symbol,
    reason: 'resolution_incomplete',
    filesVisited: ctx.traversal.visitedCount,
  };
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
