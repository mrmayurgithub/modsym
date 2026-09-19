import fs from 'node:fs';
import path from 'node:path';

export const DECL_RE = /\.(d\.ts|d\.mts|d\.cts)$/;
const MAX_VISITED = 800;

/** `d.ts` / `d.mts` / `d.cts`, or null. */
export function flavorOf(file) {
  const m = file.match(/\.d\.(m|c)?ts$/);
  if (!m) return null;
  if (m[1] === 'm') return 'd.mts';
  if (m[1] === 'c') return 'd.cts';
  return 'd.ts';
}

/**
 * Package-relative declaration path with POSIX separators.
 *
 * `path.relative` yields backslashes on Windows; emitted `declaration.file`
 * values are package-portable contract output, so they always use `/`.
 */
export function toPosixRel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export function isRelativeSpecifier(spec) {
  return spec.startsWith('.') || spec.startsWith('/');
}

export function isBareSpecifier(spec) {
  return !isRelativeSpecifier(spec) && !spec.startsWith('#');
}

/**
 * Resolve a declaration dependency found in `file`.
 *
 * Relative specifiers resolve to sibling declaration files. Self-package
 * specifiers resolve through the package's own exports map. Other bare
 * specifiers and package `#imports` are intentionally not traversed and
 * return null. Callers that must prove traversal completeness can observe
 * those unexamined edges through `onUnresolved`.
 */
export function resolveDependency(root, pkgJson, file, spec, hooks = {}) {
  if (!spec) return null;
  if (spec.startsWith('#')) {
    if (hooks.onUnresolved) hooks.onUnresolved(spec);
    return null;
  }
  if (isRelativeSpecifier(spec)) {
    const resolved = resolveFile(file, spec);
    if (!resolved && hooks.onUnresolved) hooks.onUnresolved(spec);
    return resolved;
  }
  const pkgName = pkgJson?.name;
  if (pkgName && (spec === pkgName || spec.startsWith(`${pkgName}/`))) {
    const subpath = spec === pkgName ? '.' : `./${spec.slice(pkgName.length + 1)}`;
    const rel = selfSubpathRel(pkgJson, subpath);
    if (rel) {
      const abs = resolveFile(path.join(root, 'package.json'), rel);
      if (abs) return abs;
    }
    if (hooks.onSelf) hooks.onSelf(spec);
    if (hooks.onUnresolved) hooks.onUnresolved(spec);
    return null;
  }
  if (hooks.onExternal) hooks.onExternal(spec);
  if (hooks.onUnresolved) hooks.onUnresolved(spec);
  return null;
}

/**
 * Resolve a module specifier found in `baseFile` to an absolute
 * **declaration** file path, or null.
 *
 * F5 invariant: this function never returns an ordinary source file.
 * `.js`/`.mjs`/`.cjs`/`.ts` specifiers only resolve to sibling
 * declaration files; extensionless specifiers additionally try
 * `index.d.ts`. Anything else resolves to null.
 */
export function resolveFile(baseFile, spec) {
  const target = path.resolve(path.dirname(baseFile), spec);
  const tries = [];
  if (/\.ts$/.test(target) && !DECL_RE.test(target)) {
    const bare = target.slice(0, -3);
    tries.push(`${bare}.d.ts`, `${bare}.d.mts`, `${bare}.d.cts`);
  } else if (target.endsWith('.js')) {
    const bare = target.slice(0, -3);
    tries.push(`${bare}.d.ts`, `${bare}.d.mts`, `${bare}.d.cts`);
  } else if (target.endsWith('.mjs')) {
    tries.push(`${target.slice(0, -4)}.d.mts`, `${target.slice(0, -4)}.d.ts`);
  } else if (target.endsWith('.cjs')) {
    tries.push(`${target.slice(0, -4)}.d.cts`, `${target.slice(0, -4)}.d.ts`);
  } else if (DECL_RE.test(target)) {
    tries.push(target);
  } else {
    tries.push(`${target}.d.ts`, `${target}.d.mts`, `${target}.d.cts`, path.join(target, 'index.d.ts'));
  }
  for (const candidate of tries) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return null;
}

/**
 * Resolve a `./sub` path of the package itself via its `exports` map
 * (exact keys first, then single-`*` patterns). Returns a package-root
 * relative path to a declaration-bearing value, or null.
 */
export function selfSubpathRel(pkgJson, subpath) {
  const exportsMap = pkgJson.exports;
  if (!exportsMap || typeof exportsMap !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(exportsMap, subpath)) {
    return pickTypes(exportsMap[subpath]);
  }
  for (const [key, value] of Object.entries(exportsMap)) {
    if (!key.includes('*')) continue;
    const [prefix, suffix] = key.split('*');
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
    if (!middle || middle.includes('*')) continue;
    const picked = pickTypes(value);
    if (typeof picked === 'string') {
      return picked.includes('*') ? picked.replace('*', middle) : picked;
    }
  }
  return null;
}

function pickTypes(value) {
  if (typeof value === 'string') return DECL_RE.test(value) ? value : null;
  if (value && typeof value === 'object') {
    return value.types ?? value.typings ?? value.import?.types ?? value.require?.types ?? null;
  }
  return null;
}

/**
 * Breadth-first traversal state over the declaration graph.
 * Enqueueing enforces the F5 invariant (declaration files only), the
 * visited cap, and exact traversal-state dedup for the same file and
 * sought name.
 */
export function createTraversal() {
  const visited = new Set();
  const queue = [];
  let complete = true;
  return {
    queue,
    get visitedCount() {
      return visited.size;
    },
    get complete() {
      return complete;
    },
    markIncomplete() {
      complete = false;
    },
    enqueue(file, chain, seek, cond = null, extra = {}) {
      const visitKey = traversalKey(file, seek);
      if (!file || !DECL_RE.test(file) || visited.has(visitKey)) {
        return false;
      }
      if (visited.size >= MAX_VISITED) {
        complete = false;
        return false;
      }
      visited.add(visitKey);
      queue.push({ file, chain, seek, cond, ...extra });
      return true;
    },
  };
}

function traversalKey(file, seek) {
  return `${file}\0${seek ?? ''}`;
}

/** Count declaration files under `dir`, stopping early at `limit`. */
export function countDeclFiles(dir, limit = 5) {
  let found = 0;
  const walk = current => {
    if (found >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (DECL_RE.test(entry.name)) {
        found += 1;
      }
    }
  };
  walk(dir);
  return found;
}
