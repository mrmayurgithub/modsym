#!/usr/bin/env node
// Real-package smoke corpus runner (network-dependent, not part of `npm test`).
//
// Reads test/real-corpus.json (hand-verified expectations, never rewritten
// here), resolves each case with a fresh temp MODSYM_CACHE via
// `node bin/modsym.js <spec> <symbol>`, and asserts:
// - status equals expected status
// - when an expected reason is given, reason equals it
// - when resolved, declaration.file equals the expected file and, when an
//   expected kind is given, declaration.kind equals it (a different resolved
//   file/kind is a hard failure)
// Expected abstentions (ambiguous/not_resolved) passing as abstention count
// as success. Prints one line per case plus a summary. All artifacts stay in
// temp dirs; the temp cache is removed afterwards.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const manifestPath = path.join(repoRoot, 'test', 'real-corpus.json');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`cannot read manifest ${manifestPath}: ${err.message}`);
}
const cases = manifest.cases;
if (!Array.isArray(cases) || cases.length === 0) {
  fail('manifest has no cases');
}

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-real-'));
let passed = 0;
const assertionFailures = [];
const infraFailures = [];

// Bounded retry for transient registry/network failures only (CLI errored
// with no stdout JSON, non-JSON stdout, or timeouts). Assertion mismatches
// (wrong status/reason/file/kind) are deterministic resolver results and
// are never retried.
const MAX_ATTEMPTS = 3;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // best effort; a failed sleep must not fail the run
  }
}

function runCaseOnce(spec, symbol) {
  try {
    const raw = execFileSync('node', [path.join(repoRoot, 'bin', 'modsym.js'), spec, symbol], {
      encoding: 'utf8',
      env: { ...process.env, MODSYM_CACHE: cacheDir },
      timeout: 180000,
    });
    return { raw };
  } catch (err) {
    // Abstentions exit 2 with valid JSON on stdout; only a missing stdout
    // is a genuine infra/runner failure (registry, network, timeout).
    if (typeof err.stdout === 'string' && err.stdout.trim()) {
      return { raw: err.stdout };
    }
    return { cliError: String((err.stderr || err.message || err)).split('\n')[0] };
  }
}

for (const entry of cases) {
  const { spec, symbol, expect = {} } = entry;
  const label = `${spec} ${symbol}`;
  let raw = null;
  let cliError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const outcome = runCaseOnce(spec, symbol);
    if (outcome.raw !== undefined) {
      raw = outcome.raw;
      cliError = null;
      break;
    }
    cliError = outcome.cliError;
    raw = null;
    if (attempt < MAX_ATTEMPTS) {
      sleepSync(2000 * attempt);
    }
  }
  if (raw === null) {
    console.log(`FAIL ${label} — infra/registry: CLI errored with no stdout JSON after ${MAX_ATTEMPTS} attempts: ${cliError}`);
    infraFailures.push(label);
    continue;
  }
  let actual;
  try {
    actual = JSON.parse(raw);
  } catch {
    console.log(`FAIL ${label} — infra/registry: stdout is not JSON after ${MAX_ATTEMPTS} attempts: ${raw.slice(0, 120)}`);
    infraFailures.push(label);
    continue;
  }
  const problems = [];
  if (actual.status !== expect.status) {
    problems.push(`status ${JSON.stringify(actual.status)} != expected ${JSON.stringify(expect.status)}`);
  }
  if (expect.reason !== undefined && actual.reason !== expect.reason) {
    problems.push(`reason ${JSON.stringify(actual.reason)} != expected ${JSON.stringify(expect.reason)}`);
  }
  if (expect.status === 'resolved') {
    const file = actual.declaration && actual.declaration.file;
    const kind = actual.declaration && actual.declaration.kind;
    if (expect.declarationFile !== undefined && file !== expect.declarationFile) {
      problems.push(`declaration.file ${JSON.stringify(file)} != expected ${JSON.stringify(expect.declarationFile)}`);
    }
    if (expect.declarationKind !== undefined && kind !== expect.declarationKind) {
      problems.push(`declaration.kind ${JSON.stringify(kind)} != expected ${JSON.stringify(expect.declarationKind)}`);
    }
  }
  if (problems.length === 0) {
    const detail =
      actual.status === 'resolved'
        ? `resolved ${actual.declaration.file} (${actual.declaration.kind})`
        : `${actual.status}${actual.reason ? `/${actual.reason}` : ''}`;
    console.log(`PASS ${label} — ${detail}`);
    passed += 1;
  } else {
    console.log(`FAIL ${label} — resolver regression: ${problems.join('; ')}`);
    assertionFailures.push(label);
  }
}

try {
  fs.rmSync(cacheDir, { recursive: true, force: true });
} catch {
  // best effort
}

const failed = assertionFailures.length + infraFailures.length;
console.log(
  `real-corpus: ${passed} passed, ${failed} failed (${assertionFailures.length} resolver regressions, ${infraFailures.length} infra/registry), ${cases.length} total`,
);
if (failed > 0 && infraFailures.length > 0 && assertionFailures.length === 0) {
  console.log(
    'real-corpus infra failure: registry/network unavailable after bounded retries; not a resolver regression. Retry the release gate when the registry is reachable.',
  );
}
process.exit(failed === 0 ? 0 : 1);
