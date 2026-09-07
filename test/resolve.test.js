import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIn } from '../src/resolve.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const root = name => path.join(fixtures, name);

// [fixture, symbol, expectedStatus, expectedFile, expectedLine, expectedKind, expectedReason]
const cases = [
  // Zod-style multi-hop barrel with a rename in the middle.
  ['fixture-barrel', 'gadget', 'resolved', 'leaf.d.ts', 1, 'function', null],
  ['fixture-barrel', 'Gizmo', 'resolved', 'kinds.d.ts', 1, 'class', null],
  ['fixture-barrel', 'Mode', 'resolved', 'kinds.d.ts', 6, 'enum', null],
  ['fixture-barrel', 'Alias', 'resolved', 'kinds.d.ts', 4, 'type', null],
  // AI-SDK-style bundle: bare declares + bottom export list + overloads.
  ['fixture-bundled', 'make', 'resolved', 'dist/index.d.ts', 4, 'function', null],
  ['fixture-bundled', 'Maker', 'resolved', 'dist/index.d.ts', 7, 'interface', null],
  ['fixture-bundled', 'MakerOptions', 'resolved', 'dist/index.d.ts', 1, 'interface', null],
  ['fixture-bundled', 'readyMade', 'resolved', 'dist/index.d.ts', 6, 'const', null],
  // date-fns-style exports map.
  ['fixture-exports', 'alpha', 'resolved', 'alpha.d.ts', 1, 'function', null],
  // Zustand-style self-package references.
  ['fixture-self', 'createStore', 'resolved', 'vanilla.d.ts', 1, 'const', null],
  ['fixture-self', 'create', 'resolved', 'react.d.ts', 1, 'const', null],
  ['fixture-self', 'StoreApi', 'resolved', 'vanilla.d.ts', 2, 'interface', null],
  // Got-style root-conditional exports (no "." key).
  ['fixture-rootcond', 'got', 'resolved', 'dist/source/index.d.ts', 1, 'const', null],
  ['fixture-rootcond', 'Options', 'resolved', 'dist/source/core/options.d.ts', 1, 'class', null],
  // Yup-style root index.d.ts fallback (no types/exports at all).
  ['fixture-fallback', 'tuple', 'resolved', 'index.d.ts', 1, 'function', null],
  ['fixture-fallback', 'array', 'resolved', 'index.d.ts', 2, 'function', null],
  ['fixture-fallback', 'Schema', 'resolved', 'index.d.ts', 5, 'interface', null],
  // ioredis-style default aliases.
  ['fixture-defalias', 'Redis', 'resolved', 'built/Redis.d.ts', 1, 'class', null],
  ['fixture-defalias', 'Cluster', 'resolved', 'built/cluster/index.d.ts', 1, 'class', null],
  ['fixture-defalias', 'RedisOptions', 'resolved', 'built/redis/RedisOptions.d.ts', 1, 'interface', null],
  // SWR-style minified rename chain (resolves to the true declaration).
  ['fixture-minified', 'mutate', 'resolved', 'dist/types-abc.d.ts', 3, 'const', null],
  // Hono-style imported-symbol re-export.
  ['fixture-importtrace', 'Widget', 'resolved', 'dist/types/widget.d.ts', 1, 'class', null],
  ['fixture-importtrace', 'WidgetOptions', 'resolved', 'dist/types/widget.d.ts', 4, 'interface', null],
  // Namespace re-exports, including alias-of-import.
  ['fixture-namespace', 'tool', 'resolved', 'tool.d.ts', 1, 'namespace', null],
  ['fixture-namespace', 'toolkit', 'resolved', 'tool.d.ts', 1, 'namespace', null],
  // Declaration flavor mirrors.
  ['fixture-flavors', 'run', 'resolved', 'core.d.ts', 1, 'function', null],
  // `export =` (declaration merging returns the first declaration).
  ['fixture-exporteq', 'tool', 'resolved', 'index.d.ts', 1, 'namespace', null],
  // `export default <identifier>`.
  ['fixture-exportdefault', 'client', 'resolved', 'index.d.ts', 4, 'const', null],
  // Subpath-only symbol via fallback.
  ['fixture-ambiguous', 'lonely', 'resolved', 'dist/only.d.ts', 1, 'function', null],
  ['fixture-defaultonly', 'other', 'resolved', 'index.d.ts', 1, 'const', null],
  ['fixture-external', 'local', 'resolved', 'index.d.ts', 2, 'const', null],
];

describe('resolveIn: exact resolutions', () => {
  for (const [fixture, symbol, status, file, line, kind] of cases) {
    it(`${fixture} :: ${symbol}`, () => {
      const result = resolveIn(root(fixture), symbol);
      assert.equal(result.status, status);
      assert.equal(result.decl.file, file);
      assert.equal(result.decl.line, line);
      assert.equal(result.decl.kind, kind);
    });
  }
});

describe('resolveIn: overloads are reported', () => {
  it('bundled make has 2 overloads', () => {
    const result = resolveIn(root('fixture-bundled'), 'make');
    assert.equal(result.status, 'resolved');
    assert.equal(result.decl.overloads, 2);
    assert.match(result.decl.text, /declare function make/);
  });
});

describe('resolveIn: truthful abstention', () => {
  const abstains = [
    // [fixture, symbol, expectedReason]
    ['fixture-notypes', 'work', 'no_types'],
    ['fixture-jstrap', 'Client', 'no_types'], // pg trap: .mjs must never count
    ['fixture-jstrap', 'Helper', 'no_types'],
    ['fixture-external', 'thing', 'external_reexport'],
    ['fixture-defaultonly', 'thing', 'default_only'],
    ['fixture-ambient', 'Shape', 'ambient_module'],
    ['fixture-ambient', 'makeShape', 'ambient_module'],
    ['fixture-impeq', 'format', 'unsupported_export_form'],
    // Mentioned in a visited file but never exported (method name in entry).
    ['fixture-bundled', 'build', 'qualified_only'],
    // Declared in a file the export graph never reaches for this symbol.
    ['fixture-barrel', 'WidgetOptions', 'not_found'],
  ];
  for (const [fixture, symbol, reason] of abstains) {
    it(`${fixture} :: ${symbol} abstains (${reason})`, () => {
      const result = resolveIn(root(fixture), symbol);
      assert.equal(result.status, 'not-resolved');
      assert.equal(result.reason, reason);
    });
  }

  it('effect-style ambiguity lists bounded candidates', () => {
    const result = resolveIn(root('fixture-ambiguous'), 'shared');
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.reason, 'ambiguous');
    assert.equal(result.candidates.length, 2);
    const files = result.candidates.map(c => c.file).sort();
    assert.deepEqual(files, ['dist/alpha.d.ts', 'dist/beta.d.ts']);
  });
});
