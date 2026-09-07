import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const npa = require('npm-package-arg');
const pacote = require('pacote');

/**
 * Parse an npm package spec and resolve it to an exact registry manifest.
 *
 * Accepts anything `npm install` accepts for the package position:
 * bare names, `name@version`, ranges, dist-tags, and local `file:` paths
 * (used by tests to run fully offline).
 *
 * Returns `{ name, version, tarball, integrity, manifest }`.
 * Throws an operational error (`.code` set) when the spec cannot be resolved.
 */
export async function resolveManifest(spec, opts = {}) {
  let parsed;
  try {
    parsed = npa(spec);
  } catch (err) {
    throw operational(`invalid package spec ${JSON.stringify(spec)}: ${err.message}`, 'EINVALIDSPEC');
  }
  let manifest;
  try {
    manifest = await pacote.manifest(spec, manifestOpts(opts));
  } catch (err) {
    throw operational(`cannot resolve ${JSON.stringify(spec)}: ${shortMessage(err)}`, 'ERESOLVE');
  }
  if (!manifest || !manifest.name || !manifest.version) {
    throw operational(`cannot resolve ${JSON.stringify(spec)}: empty manifest`, 'ERESOLVE');
  }
  return {
    name: manifest.name,
    version: manifest.version,
    tarball: manifest.dist?.tarball ?? null,
    integrity: manifest.dist?.integrity ?? manifest._integrity ?? null,
    manifest,
  };
}

function manifestOpts(opts) {
  const out = {};
  if (opts.cache) out.cache = opts.cache;
  if (opts.registry) out.registry = opts.registry;
  return out;
}

function shortMessage(err) {
  const msg = String(err?.message || err);
  return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
}

export function operational(message, code) {
  const err = new Error(message);
  err.code = code;
  err.operational = true;
  return err;
}
