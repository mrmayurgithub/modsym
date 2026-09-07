import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DECL_RE,
  flavorOf,
  resolveFile,
  selfSubpathRel,
  createTraversal,
  countDeclFiles,
} from '../src/graph.js';

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-graph-'));
  fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export declare const a: number;\n');
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'plain.js'), 'export const b = 2;\n');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'index.d.ts'), 'export declare const c: number;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
});

const base = () => path.join(dir, 'package.json');

describe('DECL_RE / flavorOf', () => {
  it('matches only declaration extensions', () => {
    assert.ok(DECL_RE.test('x.d.ts'));
    assert.ok(DECL_RE.test('x.d.mts'));
    assert.ok(DECL_RE.test('x.d.cts'));
    assert.ok(!DECL_RE.test('x.js'));
    assert.ok(!DECL_RE.test('x.mjs'));
    assert.ok(!DECL_RE.test('x.ts'));
  });

  it('labels flavors', () => {
    assert.equal(flavorOf('x.d.ts'), 'd.ts');
    assert.equal(flavorOf('x.d.mts'), 'd.mts');
    assert.equal(flavorOf('x.d.cts'), 'd.cts');
    assert.equal(flavorOf('x.js'), null);
  });
});

describe('resolveFile never returns source files', () => {
  it('maps .js to its sibling declaration', () => {
    assert.equal(resolveFile(base(), './a.js'), path.join(dir, 'a.d.ts'));
  });

  it('returns null for .js without a sibling declaration', () => {
    assert.equal(resolveFile(base(), './plain.js'), null);
  });

  it('returns null for explicit .mjs/.cjs without declarations', () => {
    assert.equal(resolveFile(base(), './plain.mjs'), null);
    assert.equal(resolveFile(base(), './plain.cjs'), null);
  });

  it('resolves extensionless directories to index.d.ts', () => {
    assert.equal(resolveFile(base(), './sub'), path.join(dir, 'sub', 'index.d.ts'));
  });

  it('passes declaration paths through', () => {
    assert.equal(resolveFile(base(), './a.d.ts'), path.join(dir, 'a.d.ts'));
  });
});

describe('selfSubpathRel', () => {
  const pkgJson = {
    exports: {
      '.': { types: './index.d.ts' },
      './feat': { types: './feat.d.ts' },
      './utils/*': { types: './utils/*.d.ts' },
      './legacy': './legacy.js',
    },
  };

  it('resolves exact subpaths to their types values', () => {
    assert.equal(selfSubpathRel(pkgJson, './feat'), './feat.d.ts');
  });

  it('expands single-star patterns', () => {
    assert.equal(selfSubpathRel(pkgJson, './utils/thing'), './utils/thing.d.ts');
  });

  it('rejects non-declaration values', () => {
    assert.equal(selfSubpathRel(pkgJson, './legacy'), null);
  });

  it('returns null without an exports map', () => {
    assert.equal(selfSubpathRel({}, './feat'), null);
  });
});

describe('createTraversal', () => {
  it('refuses non-declaration files and dedupes mirrors', () => {
    const t = createTraversal();
    assert.equal(t.enqueue(path.join(dir, 'plain.js'), ['.'], 'b'), false);
    assert.equal(t.enqueue(path.join(dir, 'a.d.ts'), ['.'], 'a'), true);
    assert.equal(t.enqueue(path.join(dir, 'a.d.ts'), ['.'], 'a'), false);
    assert.equal(t.visitedCount, 1);
  });
});

describe('countDeclFiles', () => {
  it('counts with an early stop', () => {
    assert.equal(countDeclFiles(dir), 2);
    assert.equal(countDeclFiles(dir, 1), 1);
    assert.equal(countDeclFiles(path.join(dir, 'nope')), 0);
  });
});
