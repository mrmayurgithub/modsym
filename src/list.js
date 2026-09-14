import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile } from './parse.js';
import { pickEntryDts } from './entry.js';
import {
  createTraversal,
  resolveDependency,
  resolveFile,
  flavorOf,
  countDeclFiles,
} from './graph.js';

/**
 * Enumerate public symbols exposed by the root declaration API surface.
 *
 * This is a discovery primitive, not a bulk resolver. It walks root
 * entries and `export *` barrels once, records public exported names,
 * and attaches declaration metadata only when the same walk can determine
 * it cheaply and confidently.
 */
export function listExportsIn(root) {
  const pkgJson = readPackageJson(root);
  const traversal = createTraversal();
  const { queue } = traversal;

  for (const entry of pickEntryDts(pkgJson)) {
    const file = resolveFile(path.join(root, 'package.json'), entry.rel);
    traversal.enqueue(file, ['.'], null, entry.condition, { includeDefault: true, fromStar: false });
  }
  if (queue.length === 0) {
    return {
      status: 'not-resolved',
      reason: 'no_types',
      ...(countDeclFiles(root) === 0 ? {} : { note: 'no-resolvable-entry' }),
      filesVisited: 0,
    };
  }

  const ctx = { root, pkgJson, traversal };
  const exports = new Map();
  while (queue.length > 0) {
    processListFile(ctx, queue.shift(), exports);
  }
  if (!traversal.complete) {
    return {
      status: 'not-resolved',
      reason: 'resolution_incomplete',
      filesVisited: traversal.visitedCount,
    };
  }

  const names = [...exports.values()]
    .filter(item => !item.starConflict)
    .map(stripInternal)
    .sort(compareExport);
  return {
    status: 'listed',
    scope: 'root',
    exports: names,
    filesVisited: traversal.visitedCount,
  };
}

function processListFile(ctx, item, exports) {
  const { root, traversal } = ctx;
  const { file, chain, cond, includeDefault, fromStar } = item;
  let parsed;
  try {
    parsed = analyzeFile(file, readUtf8);
  } catch {
    traversal.markIncomplete();
    return;
  }

  const defaultLocalNames = new Set(parsed.defaults.map(d => d.name));
  for (const [name, decls] of parsed.local) {
    if (defaultLocalNames.has(name)) continue;
    addExport(exports, name, declMeta(ctx, file, decls, cond), { fromStar });
  }

  if (includeDefault) {
    for (const d of parsed.defaults) {
      addExport(exports, 'default', declMeta(ctx, file, [d.rec], cond), { fromStar: false });
    }
    if (parsed.exportDefault) {
      addExport(exports, 'default', metadataForLocal(ctx, file, parsed, parsed.exportDefault, cond), { fromStar: false });
    }
    if (parsed.exportEq) {
      addExport(exports, parsed.exportEq, metadataForLocal(ctx, file, parsed, parsed.exportEq, cond), { fromStar: false });
    }
  }

  for (const edge of parsed.named) {
    const meta = edge.src
      ? metadataForRemote(ctx, file, edge.src, edge.local, cond)
      : metadataForLocal(ctx, file, parsed, edge.local, cond);
    addExport(exports, edge.exported, meta, { fromStar });
  }

  for (const edge of parsed.namespaces) {
    const target = resolveDependency(ctx.root, ctx.pkgJson, file, edge.src);
    addExport(exports, edge.exported, target ? { kind: 'namespace' } : null, { fromStar });
  }

  for (const src of parsed.stars) {
    const target = resolveDependency(ctx.root, ctx.pkgJson, file, src, {
      onUnresolved: () => traversal.markIncomplete(),
    });
    if (target) traversal.enqueue(target, [...chain, src], null, cond, { includeDefault: false, fromStar: true });
  }
}

function metadataForRemote(ctx, file, spec, local, cond, seen = new Set()) {
  const target = resolveDependency(ctx.root, ctx.pkgJson, file, spec);
  if (!target) return null;
  let parsed;
  try {
    parsed = analyzeFile(target, readUtf8);
  } catch {
    return null;
  }
  return metadataForLocal(ctx, target, parsed, local, cond, seen);
}

function metadataForLocal(ctx, file, parsed, local, cond, seen = new Set()) {
  const key = `${file}\0${local}`;
  if (seen.has(key)) return null;
  seen.add(key);

  if (local === 'default') {
    if (parsed.defaults.length > 0) {
      return declMeta(ctx, file, [parsed.defaults[0].rec], cond);
    }
    if (parsed.exportDefault) {
      return metadataForLocal(ctx, file, parsed, parsed.exportDefault, cond, seen);
    }
  }

  if (parsed.local.has(local)) return declMeta(ctx, file, parsed.local.get(local), cond);
  if (parsed.pendingLocal.has(local)) return declMeta(ctx, file, parsed.pendingLocal.get(local), cond);

  const imp = parsed.imports.get(local);
  if (imp) {
    if (imp.imported === '*') return { kind: 'namespace' };
    return metadataForRemote(ctx, file, imp.src, imp.imported, cond, seen);
  }

  const sameFile = parsed.named.find(n => n.src === null && n.exported === local && n.local !== local);
  if (sameFile) return metadataForLocal(ctx, file, parsed, sameFile.local, cond, seen);

  const reExport = parsed.named.find(n => n.src && n.exported === local);
  if (reExport) return metadataForRemote(ctx, file, reExport.src, reExport.local, cond, seen);

  if (parsed.exportEq === local) return null;
  return null;
}

function declMeta(ctx, file, decls, cond) {
  const first = decls?.[0];
  if (!first) return null;
  return {
    kind: first.kind,
    file: path.relative(ctx.root, file),
    line: first.line,
    condition: cond ?? null,
    flavor: flavorOf(file),
  };
}

function addExport(exports, name, meta, opts = {}) {
  if (!name || typeof name !== 'string') return;
  const clean = cleanMeta(name, meta, opts);
  const existing = exports.get(name);
  if (!existing) {
    exports.set(name, clean);
    return;
  }
  exports.set(name, mergeExport(existing, clean));
}

function cleanMeta(name, meta, opts = {}) {
  const out = { name };
  if (opts.fromStar) out.fromStar = true;
  if (meta?.kind) out.kind = String(meta.kind);
  if (meta?.file) out.file = String(meta.file);
  if (Number.isInteger(meta?.line) && meta.line > 0) out.line = meta.line;
  return out;
}

function mergeExport(a, b) {
  if (a.fromStar && b.fromStar) {
    return { name: a.name, starConflict: true };
  }
  if (a.starConflict && b.fromStar) return a;
  if (a.starConflict && !b.fromStar) return { ...b };
  if (a.fromStar && !b.fromStar) return { ...b };
  if (!a.fromStar && b.fromStar) return { ...a };

  const out = { name: a.name };
  for (const key of ['kind', 'file', 'line']) {
    if (a[key] === undefined) {
      if (b[key] !== undefined) out[key] = b[key];
    } else if (b[key] === undefined || a[key] === b[key]) {
      out[key] = a[key];
    }
  }
  if (out.file === undefined) delete out.line;
  return out;
}

function compareExport(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function stripInternal(item) {
  const { fromStar, starConflict, ...publicItem } = item;
  return publicItem;
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

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}
