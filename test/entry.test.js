import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickEntryDts, pickSubpathTypes } from '../src/entry.js';

describe('pickEntryDts', () => {
  it('prefers exports.types, then typings, then types field', () => {
    const out = pickEntryDts({
      types: './a.d.ts',
      exports: { '.': { types: './b.d.ts', import: './b.js' } },
    });
    // Both are queued as candidates (exports first); traversal dedupes mirrors.
    assert.deepEqual(out, [
      { rel: './b.d.ts', condition: 'exports.types' },
      { rel: './a.d.ts', condition: 'types' },
    ]);
  });

  it('reads root-conditional exports without a "." key (got-style)', () => {
    const out = pickEntryDts({
      exports: { types: './dist/source/index.d.ts', default: './dist/source/index.js' },
    });
    assert.deepEqual(out, [{ rel: './dist/source/index.d.ts', condition: 'exports.types' }]);
  });

  it('falls back to root index.d.ts when nothing is advertised (yup-style)', () => {
    const out = pickEntryDts({ name: 'x', version: '1.0.0', main: 'index.js' });
    assert.deepEqual(out.map(c => c.rel), ['./index.d.ts', './index.d.mts', './index.d.cts']);
    assert.ok(out.every(c => c.condition === 'root-fallback'));
  });

  it('does not treat dot-less non-condition keys as a root entry', () => {
    // A subpath-only map must not be mistaken for root conditions.
    const out = pickEntryDts({ exports: { './feature': { types: './f.d.ts' } } });
    assert.deepEqual(out.map(c => c.rel), ['./index.d.ts', './index.d.mts', './index.d.cts']);
  });

  it('dedupes identical rels', () => {
    const out = pickEntryDts({ types: './a.d.ts', exports: { '.': { types: './a.d.ts' } } });
    assert.deepEqual(out, [{ rel: './a.d.ts', condition: 'exports.types' }]);
  });
});

describe('pickSubpathTypes', () => {
  it('accepts declaration strings and nested conditional types', () => {
    assert.equal(pickSubpathTypes('./x.d.ts'), './x.d.ts');
    assert.equal(pickSubpathTypes({ import: { types: './x.d.ts' } }), './x.d.ts');
    assert.equal(pickSubpathTypes({ types: './x.d.ts' }), './x.d.ts');
  });

  it('rejects plain-JS fallbacks (declaration-only traversal)', () => {
    assert.equal(pickSubpathTypes({ default: './x.js' }), null);
    assert.equal(pickSubpathTypes('./x.js'), './x.js'); // strings pass through; resolveFile filters
    assert.equal(pickSubpathTypes(null), null);
  });
});
