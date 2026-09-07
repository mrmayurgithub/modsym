import fs from 'node:fs';
import path from 'node:path';
import { acquire } from './acquire.js';
import { resolveIn } from './resolve.js';
import { serialize } from './serialize.js';
import { operational } from './spec.js';

export { resolveIn } from './resolve.js';
export { serialize } from './serialize.js';
export { acquire } from './acquire.js';
export { pickEntryDts } from './entry.js';

/**
 * Resolve one bare public symbol of an npm package to its published
 * TypeScript declaration.
 *
 * Returns the public JSON-serializable result object (see serialize.js).
 * Only throws operational errors (bad spec/symbol, fetch failures).
 */
export async function resolvePackageSymbol(spec, symbol, opts = {}) {
  const cleanSymbol = validateSymbol(symbol);
  const { root, meta } = await acquire(spec, opts);
  const identity = describePackage(root, meta, spec);
  const internal = resolveIn(root, cleanSymbol);
  return serialize(internal, { ...identity, symbol: cleanSymbol });
}

function validateSymbol(symbol) {
  if (typeof symbol !== 'string') {
    throw operational('symbol must be a string', 'EINVALIDSYMBOL');
  }
  const clean = symbol.trim();
  if (!clean) throw operational('symbol must not be empty', 'EINVALIDSYMBOL');
  if (clean.length > 200) throw operational('symbol is too long', 'EINVALIDSYMBOL');
  if (/[\0-\x1f\x7f]/.test(clean)) throw operational('symbol contains control characters', 'EINVALIDSYMBOL');
  return clean;
}

function describePackage(root, meta, spec) {
  if (meta) return { name: meta.name, version: meta.version };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return { name: String(pkg.name ?? spec), version: String(pkg.version ?? '0.0.0') };
  } catch {
    return { name: String(spec), version: '0.0.0' };
  }
}
