import fs from 'node:fs';
import path from 'node:path';
import { acquire } from './acquire.js';
import { resolveIn } from './resolve.js';
import { listExportsIn } from './list.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, serialize, serializeList } from './serialize.js';
import { operational } from './spec.js';

export { resolveIn } from './resolve.js';
export { listExportsIn } from './list.js';
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, serialize, serializeList } from './serialize.js';
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

/**
 * List public symbols exposed by a package's root declaration surface.
 *
 * Returns bounded JSON for agent discovery. Use `resolvePackageSymbol` for
 * the exact declaration behind a selected name.
 */
export async function listPackageExports(spec, opts = {}) {
  const listOpts = validateListOptions(opts);
  const { root, meta } = await acquire(spec, opts);
  const identity = describePackage(root, meta, spec);
  const internal = listExportsIn(root);
  return serializeList(internal, identity, listOpts);
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

function validateListOptions(opts) {
  const out = {};
  if (opts.match !== undefined && opts.match !== null) {
    if (typeof opts.match !== 'string') {
      throw operational('match must be a string', 'EINVALIDMATCH');
    }
    const match = opts.match.trim();
    if (!match) throw operational('match must not be empty', 'EINVALIDMATCH');
    if (match.length > 200) throw operational('match is too long', 'EINVALIDMATCH');
    if (/[\0-\x1f\x7f]/.test(match)) {
      throw operational('match contains control characters', 'EINVALIDMATCH');
    }
    out.match = match;
  }
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw operational(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`, 'EINVALIDLIMIT');
  }
  out.limit = limit;
  return out;
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
