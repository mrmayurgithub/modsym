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

export function isRelativeSpecifier(spec) {
  return spec.startsWith('.') || spec.startsWith('/');
}

export function isBareSpecifier(spec) {
  return !isRelativeSpecifier(spec) && !spec.startsWith('#');
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
 * visited cap, and byte-identical mirror dedup (`.d.ts` vs `.d.cts`
 * mirrors of the same barrel are traversed once).
 */
export function createTraversal() {
  const visited = new Set();
  const seenContent = new Set();
  const queue = [];
  return {
    queue,
    get visitedCount() {
      return visited.size;
    },
    enqueue(file, chain, seek, cond = null) {
      if (!file || !DECL_RE.test(file) || visited.has(file) || visited.size >= MAX_VISITED) {
        return false;
      }
      const key = contentKey(file);
      if (key && seenContent.has(key)) return false;
      if (key) seenContent.add(key);
      visited.add(file);
      queue.push({ file, chain, seek, cond });
      return true;
    },
  };
}

function contentKey(file) {
  try {
    const bytes = fs.readFileSync(file);
    let hash = 0;
    for (let i = 0; i < bytes.length; i++) hash = (hash * 31 + bytes[i]) | 0;
    return `${bytes.length}:${hash}`;
  } catch {
    return null;
  }
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
