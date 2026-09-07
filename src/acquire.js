import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { operational, resolveManifest } from './spec.js';

const require = createRequire(import.meta.url);
const npa = require('npm-package-arg');
const pacote = require('pacote');

/**
 * Acquire an extracted package directory for a spec, reusing caches.
 *
 * - Registry specs: extracted once per tarball integrity under the cache
 *   directory (`~/.cache/modsym`, `XDG_CACHE_HOME`, or `MODSYM_CACHE`),
 *   reusing npm/pacote's own download cache underneath. Nothing is written
 *   to the user's working directory.
 * - Local `file:`/directory specs: used in place (test path), never copied.
 *
 * Returns `{ root, fromCache }` where `root` is the package directory
 * (the directory containing `package.json`).
 */
export async function acquire(spec, opts = {}) {
  const parsed = safeParse(spec);
  if (parsed && (parsed.type === 'directory' || parsed.type === 'file')) {
    return acquireLocal(parsed, spec);
  }
  return acquireRegistry(spec, opts);
}

function safeParse(spec) {
  try {
    return npa(spec);
  } catch {
    return null;
  }
}

function acquireLocal(parsed, spec) {
  // npa resolves relative paths against cwd already (fetchSpec is absolute).
  const p = parsed.fetchSpec;
  if (!p || !fs.existsSync(p)) {
    throw operational(`local path does not exist: ${spec}`, 'ENOENTPKG');
  }
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    assertPackageDir(p, spec);
    return { root: p, fromCache: false };
  }
  // A tarball file: extract via pacote into the integrity-keyed cache so the
  // working directory stays clean. Fall through to registry-style handling
  // keyed by file content would be ideal; simplest correct approach is a
  // temp dir per call (tests use directories; tarballs are rare here).
  throw operational(`file tarballs are not supported in v0.1: ${spec}`, 'EUNSUPPORTED');
}

function assertPackageDir(dir, spec) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!pkg || typeof pkg !== 'object' || !pkg.name) throw new Error('no name');
  } catch {
    throw operational(`not a package directory: ${spec}`, 'ENOTPKG');
  }
}

async function acquireRegistry(spec, opts) {
  const meta = await resolveManifest(spec, opts);
  const cacheDir = opts.packageCache || defaultCacheDir();
  const key = cacheKey(meta);
  const dest = path.join(cacheDir, key);
  if (isExtracted(dest)) {
    return { root: dest, fromCache: true, meta };
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  removeDir(tmp);
  try {
    await pacote.extract(spec, tmp, extractOpts(opts));
  } catch (err) {
    removeDir(tmp);
    throw operational(`cannot fetch ${JSON.stringify(spec)}: ${shortMessage(err)}`, 'EFETCH');
  }
  if (!isExtracted(tmp)) {
    removeDir(tmp);
    throw operational(`cannot fetch ${JSON.stringify(spec)}: empty package`, 'EFETCH');
  }
  try {
    fs.renameSync(tmp, dest);
  } catch {
    // Lost a race with a concurrent extraction; reuse whatever won.
    removeDir(tmp);
    if (!isExtracted(dest)) {
      throw operational(`cannot fetch ${JSON.stringify(spec)}: cache race`, 'EFETCH');
    }
    return { root: dest, fromCache: true, meta };
  }
  return { root: dest, fromCache: false, meta };
}

function isExtracted(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile();
  } catch {
    return false;
  }
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function cacheKey(meta) {
  const base = meta.integrity
    ? Buffer.from(String(meta.integrity)).toString('base64url')
    : `${meta.name}@${meta.version}`.replace(/[^a-zA-Z0-9@._-]+/g, '_');
  return `${meta.name.replace(/^@/, '').replace(/\//g, '__')}@${meta.version}+${base}`.slice(0, 180);
}

function defaultCacheDir() {
  if (process.env.MODSYM_CACHE) return process.env.MODSYM_CACHE;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'modsym', 'pkgs');
}

function extractOpts(opts) {
  const out = {};
  if (opts.cache) out.cache = opts.cache;
  if (opts.registry) out.registry = opts.registry;
  return out;
}

function shortMessage(err) {
  const msg = String(err?.message || err);
  return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
}
