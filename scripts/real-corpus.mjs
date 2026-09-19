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
let failed = 0;

for (const entry of cases) {
  const { spec, symbol, expect = {} } = entry;
  const label = `${spec} ${symbol}`;
  let raw = null;
  let cliError = null;
  try {
    raw = execFileSync('node', [path.join(repoRoot, 'bin', 'modsym.js'), spec, symbol], {
      encoding: 'utf8',
      env: { ...process.env, MODSYM_CACHE: cacheDir },
      timeout: 180000,
    });
  } catch (err) {
    // Abstentions exit 2 with valid JSON on stdout; only a missing stdout
    // is a genuine runner failure.
    if (typeof err.stdout === 'string' && err.stdout.trim()) {
      raw = err.stdout;
    } else {
      cliError = String((err.stderr || err.message || err)).split('\n')[0];
    }
  }
  if (raw === null) {
    console.log(`FAIL ${label} — CLI errored with no stdout JSON: ${cliError}`);
    failed += 1;
    continue;
  }
  let actual;
  try {
    actual = JSON.parse(raw);
  } catch {
    console.log(`FAIL ${label} — stdout is not JSON: ${raw.slice(0, 120)}`);
    failed += 1;
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
    console.log(`FAIL ${label} — ${problems.join('; ')}`);
    failed += 1;
  }
}

try {
  fs.rmSync(cacheDir, { recursive: true, force: true });
} catch {
  // best effort
}

console.log(`real-corpus: ${passed} passed, ${failed} failed, ${cases.length} total`);
process.exit(failed === 0 ? 0 : 1);
