#!/usr/bin/env node
// Synthetic offline benchmark for modsym resolution.
//
// - Generates synthetic declaration graphs in fresh temp dirs (no network).
// - Asserts CORRECTNESS first; any failure exits 1 before timing.
// - Timing thresholds are informational only (never nonzero on slowness).
//
// Cold-vs-warm cache note: all scenarios call resolveIn()/listExportsIn()
// directly on local package dirs, so no registry fetch and no MODSYM_CACHE
// involvement occurs. A cold-vs-warm comparison using a local `file:`
// package plus fresh vs reused MODSYM_CACHE is N/A for `file:` specs
// (there is nothing to cache); this script therefore reports warm,
// in-process timings only and does not fake cache numbers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolveIn } from '../src/resolve.js';
import { listExportsIn } from '../src/list.js';
import {
  serialize,
  serializeList,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from '../src/serialize.js';

// Traversal-limit constant, read from src (do not guess):
//   src/graph.js:5  ->  const MAX_VISITED = 800;
// resolve.js also uses MAX_CANDIDATES = 10 (src/resolve.js:15),
// MAX_BARREL_FANOUT = 50 (src/resolve.js:16); serialize.js bounds output
// (MAX_CHAIN_ITEMS = 20, MAX_TEXT_CHARS = 600, src/serialize.js:1-2).
const MAX_VISITED = 800; // src/graph.js:5
const MAX_VISITED_AT = 'src/graph.js:5';

const CHAIN_SHORT_N = 5;
const CHAIN_MEDIUM_N = 50;
const CHAIN_NEAR_N = MAX_VISITED - 100; // 700: resolves, just under the cap
const CHAIN_BEYOND_N = MAX_VISITED + 100; // 900: must abstain
const BARREL_K = 60;
const LIST_K = 150;
const LIST_LIMIT = 20;

// Serialized output must stay small by construction (~10KB max per
// serialize.js docs). Generous hard bound for the assertion.
const MAX_OUTPUT_BYTES = 12 * 1024;

class BenchFailure extends Error {}

function fail(msg) {
  // Thrown (not process.exit) so temp-dir cleanup in `finally` still runs.
  throw new BenchFailure(msg);
}

function writePkg(dir, name, files) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', types: './index.d.ts' }, null, 2) + '\n',
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function pad(n, w = 4) {
  return String(n).padStart(w, '0');
}

// Chain package: index -> c000 -> ... -> c{N-1} -> leaf, total N+1 files.
// Each hop: export { target } from "./next.js"; leaf declares target.
function buildChainPackage(dir, n) {
  const name = `bench-chain-${n}`;
  const files = {};
  if (n <= 0) {
    files['index.d.ts'] = 'export declare function target(): void;\n';
  } else {
    files['index.d.ts'] = `export { target } from "./c${pad(0)}.js";\n`;
    for (let i = 0; i < n; i += 1) {
      const next = i + 1 < n ? `./c${pad(i + 1)}.js` : './leaf.js';
      files[`c${pad(i)}.d.ts`] = `export { target } from "${next}";\n`;
    }
    files['leaf.d.ts'] = 'export declare function target(): void;\n';
  }
  writePkg(dir, name, files);
  return { name, version: '1.0.0', expectedFile: n <= 0 ? 'index.d.ts' : 'leaf.d.ts' };
}

// Barrel package: index re-exports K leaves via `export *`.
function buildBarrelPackage(dir, name, k, withTarget) {
  const files = {};
  const lines = [];
  for (let i = 0; i < k; i += 1) {
    lines.push(`export * from "./leaf${pad(i)}.js";`);
    files[`leaf${pad(i)}.d.ts`] =
      (withTarget && i === 0 ? 'export declare function target(): void;\n' : '') +
      `export declare function sym${pad(i)}(): void;\n`;
  }
  files['index.d.ts'] = lines.join('\n') + '\n';
  writePkg(dir, name, files);
  return { name, version: '1.0.0' };
}

function resolvePublic(root, ident, symbol) {
  return serialize(resolveIn(root, symbol), { ...ident, symbol });
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sorted.length ? sum / sorted.length : 0;
  const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  return {
    min: sorted.length ? sorted[0] : 0,
    p50: pick(0.5),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    mean,
  };
}

function benchFn(fn, warmup, iterations) {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}

function printHelp() {
  const lines = [
    'usage: node scripts/bench.mjs [--iterations N] [--warmup M] [--scenario name]',
    '',
    'Offline synthetic benchmark: builds declaration graphs in fresh temp dirs',
    '(no network), asserts correctness first, then reports wall-clock timings.',
    '',
    'options:',
    '  --iterations N   timed runs per scenario (default 20)',
    '  --warmup M       untimed warmup runs per scenario (default 3)',
    '  --scenario name  run only one scenario (repeatable); default: all',
    '  --help, -h       show this help',
    '',
    'scenarios:',
    `  chain-short        named re-export chain, N=${CHAIN_SHORT_N}`,
    `  chain-medium       named re-export chain, N=${CHAIN_MEDIUM_N}`,
    `  chain-near-limit   named re-export chain, N=${CHAIN_NEAR_N} (MAX_VISITED-100)`,
    `  chain-beyond-limit named re-export chain, N=${CHAIN_BEYOND_N} (MAX_VISITED+100)`,
    `  barrel             index re-exporting K=${BARREL_K} leaves`,
    `  list-truncate      K=${LIST_K} leaves, list limit=${LIST_LIMIT}`,
    '',
    'cache note: scenarios call resolveIn()/listExportsIn() directly on local',
    'package dirs, so no registry fetch and no MODSYM_CACHE involvement occurs.',
    'A cold-vs-warm comparison using a local `file:` package plus fresh vs',
    'reused MODSYM_CACHE is N/A for `file:` specs (there is nothing to cache);',
    'only warm in-process timings are reported and no cache numbers are faked.',
    '',
    `limits: MAX_VISITED=${MAX_VISITED} (${MAX_VISITED_AT}),`,
    `  DEFAULT_LIST_LIMIT=${DEFAULT_LIST_LIMIT}, MAX_LIST_LIMIT=${MAX_LIST_LIMIT}.`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function parseArgs(argv) {
  const out = { iterations: 20, warmup: 3, scenarios: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--iterations') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) fail('--iterations requires a positive integer');
      out.iterations = v;
    } else if (a === '--warmup') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) fail('--warmup requires a non-negative integer');
      out.warmup = v;
    } else if (a === '--scenario') {
      const v = argv[++i];
      if (!v) fail('--scenario requires a name');
      out.scenarios.push(v);
    } else {
      fail(`unknown option ${JSON.stringify(a)} (see --help)`);
    }
  }
  return out;
}

const SCENARIO_NAMES = [
  'chain-short',
  'chain-medium',
  'chain-near-limit',
  'chain-beyond-limit',
  'barrel',
  'list-truncate',
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const wanted = args.scenarios.length ? args.scenarios : SCENARIO_NAMES;
  for (const name of wanted) {
    if (!SCENARIO_NAMES.includes(name)) fail(`unknown scenario ${JSON.stringify(name)}`);
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-bench-'));
  const dirs = [];
  try {
    // Build one package dir per scenario up front.
    const pkgs = {};
    const mk = (key, builder) => {
      const dir = path.join(tmpBase, key);
      fs.mkdirSync(dir, { recursive: true });
      dirs.push(dir);
      pkgs[key] = { dir, ...builder(dir) };
    };
    if (wanted.includes('chain-short')) mk('chain-short', (d) => buildChainPackage(d, CHAIN_SHORT_N));
    if (wanted.includes('chain-medium')) mk('chain-medium', (d) => buildChainPackage(d, CHAIN_MEDIUM_N));
    if (wanted.includes('chain-near-limit')) mk('chain-near-limit', (d) => buildChainPackage(d, CHAIN_NEAR_N));
    if (wanted.includes('chain-beyond-limit')) {
      mk('chain-beyond-limit', (d) => buildChainPackage(d, CHAIN_BEYOND_N));
    }
    if (wanted.includes('barrel')) {
      mk('barrel', (d) => buildBarrelPackage(d, 'bench-barrel', BARREL_K, true));
    }
    if (wanted.includes('list-truncate')) {
      mk('list-truncate', (d) => buildBarrelPackage(d, 'bench-list', LIST_K, false));
    }

    // ---- 2. CORRECTNESS FIRST (before any timing) ----
    const checks = {};
    const resolveScenario = (key, symbol) => {
      const { dir, name, version } = pkgs[key];
      const out = resolvePublic(dir, { name, version }, symbol);
      checks[key] = out;
      return out;
    };

    for (const key of ['chain-short', 'chain-medium', 'chain-near-limit']) {
      if (!wanted.includes(key)) continue;
      const out = resolveScenario(key, 'target');
      if (out.status !== 'resolved') fail(`${key}: expected resolved, got ${out.status} (${out.reason || 'no reason'})`);
      if (out.declaration?.file !== pkgs[key].expectedFile) {
        fail(`${key}: expected file ${pkgs[key].expectedFile}, got ${out.declaration?.file}`);
      }
    }
    if (wanted.includes('chain-beyond-limit')) {
      const out = resolveScenario('chain-beyond-limit', 'target');
      if (out.status !== 'not_resolved' || out.reason !== 'resolution_incomplete') {
        fail(`chain-beyond-limit: expected not_resolved/resolution_incomplete, got ${out.status}/${out.reason}`);
      }
    }
    if (wanted.includes('barrel')) {
      const out = resolveScenario('barrel', 'target');
      if (out.status !== 'resolved') fail(`barrel: expected resolved, got ${out.status}`);
      if (out.declaration?.file !== 'leaf0000.d.ts') {
        fail(`barrel: expected file leaf0000.d.ts, got ${out.declaration?.file}`);
      }
    }
    let listCheck = null;
    if (wanted.includes('list-truncate')) {
      const { dir, name, version } = pkgs['list-truncate'];
      const internal = listExportsIn(dir);
      const out = serializeList(internal, { name, version }, { limit: LIST_LIMIT });
      listCheck = out;
      if (out.status !== 'listed') fail(`list-truncate: expected listed, got ${out.status} (${out.reason || ''})`);
      if (out.shown !== LIST_LIMIT) fail(`list-truncate: expected shown=${LIST_LIMIT}, got ${out.shown}`);
      if (out.truncated !== true) fail('list-truncate: expected truncated=true');
      if (out.total < LIST_K) fail(`list-truncate: expected total>=${LIST_K}, got ${out.total}`);
      if (out.exports.length > LIST_LIMIT) fail('list-truncate: exports exceed limit');
    }

    // Determinism: repeated runs byte-identical.
    const canonical = (o) => JSON.stringify(o);
    for (const key of ['chain-short', 'chain-medium', 'chain-near-limit', 'chain-beyond-limit', 'barrel']) {
      if (!wanted.includes(key)) continue;
      const again = resolvePublic(pkgs[key].dir, { name: pkgs[key].name, version: pkgs[key].version }, 'target');
      if (canonical(again) !== canonical(checks[key])) fail(`${key}: repeated run not byte-identical`);
    }
    if (wanted.includes('list-truncate')) {
      const { dir, name, version } = pkgs['list-truncate'];
      const again = serializeList(listExportsIn(dir), { name, version }, { limit: LIST_LIMIT });
      if (canonical(again) !== canonical(listCheck)) fail('list-truncate: repeated run not byte-identical');
    }

    // Output size within bounds.
    for (const key of ['chain-short', 'chain-medium', 'chain-near-limit', 'chain-beyond-limit', 'barrel']) {
      if (!wanted.includes(key)) continue;
      const bytes = Buffer.byteLength(canonical(checks[key]), 'utf8');
      if (bytes > MAX_OUTPUT_BYTES) fail(`${key}: output ${bytes}B exceeds ${MAX_OUTPUT_BYTES}B bound`);
    }
    if (wanted.includes('list-truncate')) {
      const bytes = Buffer.byteLength(canonical(listCheck), 'utf8');
      if (bytes > MAX_OUTPUT_BYTES) fail(`list-truncate: output ${bytes}B exceeds ${MAX_OUTPUT_BYTES}B bound`);
    }

    // ---- 3. TIMINGS (informational only) ----
    const results = [];
    const timeResolve = (key, symbol) => {
      const { dir, name, version } = pkgs[key];
      return benchFn(() => resolvePublic(dir, { name, version }, symbol), args.warmup, args.iterations);
    };
    const pushResolve = (name, key, params) => {
      const samples = timeResolve(key, 'target');
      const out = checks[key];
      results.push({
        name,
        params,
        status: out.status,
        outputBytes: Buffer.byteLength(canonical(out), 'utf8'),
        timingsMs: stats(samples),
        samplesMs: samples,
      });
    };
    if (wanted.includes('chain-short')) pushResolve('chain-short', 'chain-short', { kind: 'chain', n: CHAIN_SHORT_N });
    if (wanted.includes('chain-medium')) pushResolve('chain-medium', 'chain-medium', { kind: 'chain', n: CHAIN_MEDIUM_N });
    if (wanted.includes('chain-near-limit')) {
      pushResolve('chain-near-limit', 'chain-near-limit', { kind: 'chain', n: CHAIN_NEAR_N, maxVisited: MAX_VISITED });
    }
    if (wanted.includes('chain-beyond-limit')) {
      pushResolve('chain-beyond-limit', 'chain-beyond-limit', {
        kind: 'chain',
        n: CHAIN_BEYOND_N,
        maxVisited: MAX_VISITED,
        expect: 'not_resolved/resolution_incomplete',
      });
    }
    if (wanted.includes('barrel')) pushResolve('barrel', 'barrel', { kind: 'barrel', k: BARREL_K });
    if (wanted.includes('list-truncate')) {
      const { dir, name, version } = pkgs['list-truncate'];
      const samples = benchFn(
        () => serializeList(listExportsIn(dir), { name, version }, { limit: LIST_LIMIT }),
        args.warmup,
        args.iterations,
      );
      results.push({
        name: 'list-truncate',
        params: { kind: 'barrel-list', k: LIST_K, limit: LIST_LIMIT },
        status: listCheck.status,
        outputBytes: Buffer.byteLength(canonical(listCheck), 'utf8'),
        timingsMs: stats(samples),
        samplesMs: samples,
      });
    }

    const report = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      warmup: args.warmup,
      iterations: args.iterations,
      limits: {
        maxVisited: MAX_VISITED,
        maxVisitedAt: MAX_VISITED_AT,
        defaultListLimit: DEFAULT_LIST_LIMIT,
        maxListLimit: MAX_LIST_LIMIT,
      },
      scenarios: results,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

const here = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || '') === here) {
  try {
    main();
  } catch (err) {
    if (err instanceof BenchFailure) {
      process.stderr.write(`bench correctness failure: ${err.message}\n`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
