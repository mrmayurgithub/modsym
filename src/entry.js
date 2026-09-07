/**
 * Declaration entry discovery.
 *
 * Determines which `.d.ts` file(s) represent a package's root public API,
 * and labels each with the export condition that selected it.
 *
 * Priority: `exports["."].types` → `exports["."].typings` → nested
 * conditional types → `types`/`typings` fields → root `index.d.ts`
 * fallback (packages that ship declarations without advertising them).
 *
 * Root-conditional `exports` sugar (`{"types": …, "default": …}` with no
 * `"."` key, as used by e.g. got) is treated as the root entry's
 * conditions. JavaScript condition values are only used to *locate*
 * sibling declarations — plain `.js`/`.mjs`/`.cjs` files are never
 * returned as entries themselves (see graph.resolveFile).
 *
 * Returns `[{ rel, condition }]` with duplicates removed.
 */
export function pickEntryDts(pkgJson) {
  const cands = [];
  const push = (rel, condition) => {
    if (typeof rel === 'string') cands.push({ rel, condition });
  };
  let dot = pkgJson?.exports?.['.'];
  if (!dot && pkgJson?.exports && typeof pkgJson.exports === 'object') {
    const keys = Object.keys(pkgJson.exports);
    if (keys.length > 0 && keys.every(k => !k.startsWith('.'))) dot = pkgJson.exports;
  }
  const hasTypesEntry =
    (typeof dot === 'object' &&
      dot !== null &&
      (typeof dot.types === 'string' || typeof dot.typings === 'string')) ||
    typeof pkgJson?.types === 'string' ||
    typeof pkgJson?.typings === 'string';
  if (dot) {
    if (typeof dot === 'string') {
      push(dot, 'exports');
    } else if (typeof dot === 'object') {
      for (const k of ['types', 'typings']) {
        if (typeof dot[k] === 'string') push(dot[k], `exports.${k}`);
      }
      // Only infer declarations from JS conditions when no types entry exists.
      if (!hasTypesEntry) {
        for (const cond of ['import', 'require', 'default', 'node']) {
          const v = dot[cond];
          if (typeof v === 'string') push(v, `exports.${cond}`);
          else if (v && typeof v === 'object') {
            for (const k of ['types', 'typings', 'default']) {
              if (typeof v[k] === 'string') push(v[k], `exports.${cond}.${k}`);
            }
          }
        }
      }
    }
  }
  for (const k of ['types', 'typings']) {
    if (typeof pkgJson?.[k] === 'string') push(pkgJson[k], k);
  }
  if (cands.length === 0) {
    for (const f of ['./index.d.ts', './index.d.mts', './index.d.cts']) {
      push(f, 'root-fallback');
    }
  }
  const seen = new Set();
  return cands.filter(c => (seen.has(c.rel) ? false : (seen.add(c.rel), true)));
}

/**
 * Pick the declaration-bearing value of one subpath export entry.
 * Never returns a plain-JS `default` fallback: subpaths without any
 * types value are skipped by the caller (see resolve.js phase 2).
 */
export function pickSubpathTypes(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.types ?? value.typings ?? value.import?.types ?? value.require?.types ?? null;
  }
  return null;
}
