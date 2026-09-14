import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIn } from '../src/resolve.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const root = name => path.join(fixtures, name);

function unexaminedStarResolveFixture(specifier) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-unexamined-star-'));
  const packageJson = {
    name: 'fixture-resolve-unexamined-star',
    version: '1.0.0',
    types: './index.d.ts',
  };
  if (specifier.startsWith('#')) packageJson.imports = { [specifier]: './hidden.d.ts' };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(
    path.join(dir, 'index.d.ts'),
    `export * from "./present.js";\nexport * from "${specifier}";\n`,
  );
  fs.writeFileSync(path.join(dir, 'present.d.ts'), 'export declare const target: true;\n');
  if (specifier.startsWith('#')) {
    fs.writeFileSync(path.join(dir, 'hidden.d.ts'), 'export declare const target: false;\n');
  }
  return dir;
}

function directHitWithStarSiblingFixture(specifier) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-direct-star-sibling-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-resolve-direct-star-sibling',
    version: '1.0.0',
    types: './index.d.ts',
  }));
  fs.writeFileSync(
    path.join(dir, 'index.d.ts'),
    `export declare function Foo(): void;\nexport * from "${specifier}";\n`,
  );
  return dir;
}

function conditionalEntryFixture({ esm, cjs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-conditional-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-resolve-conditional',
    version: '1.0.0',
    exports: {
      '.': {
        import: './index.mjs',
        require: './index.cjs',
      },
    },
  }));
  fs.writeFileSync(path.join(dir, 'index.d.mts'), esm);
  fs.writeFileSync(path.join(dir, 'index.d.cts'), cjs);
  return dir;
}

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

describe('resolveIn: direct hits with unexamined star siblings', () => {
  it('abstains when a direct local hit has an external star sibling', () => {
    const result = resolveIn(directHitWithStarSiblingFixture('some-external'), 'Foo');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 1);
  });

  it('abstains when a direct local hit has a missing relative star sibling', () => {
    const result = resolveIn(directHitWithStarSiblingFixture('./missing.js'), 'Foo');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 1);
  });

  it('abstains when a nested direct hit has an unexamined star sibling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-nested-direct-star-sibling-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-nested-direct-star-sibling',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export * from "./a.js";\n');
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export * from "./b.js";\n');
    fs.writeFileSync(path.join(dir, 'b.d.ts'), 'export declare function Foo(): void;\nexport * from "some-external";\n');

    const result = resolveIn(dir, 'Foo');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 3);
  });

  it('resolves when a direct local hit has a resolvable agreeing star sibling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-direct-star-agreement-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-direct-star-agreement',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare function Foo(): void;\nexport * from "./other.js";\n');
    fs.writeFileSync(path.join(dir, 'other.d.ts'), 'export declare function Foo(): void;\n');

    const result = resolveIn(dir, 'Foo');

    assert.equal(result.status, 'resolved');
    assert.equal(result.decl.file, 'index.d.ts');
    assert.equal(result.reason, undefined);
  });

  it('does not choose a direct local hit over a conflicting resolvable star sibling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-direct-star-conflict-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-direct-star-conflict',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare function Foo(): void;\nexport * from "./other.js";\n');
    fs.writeFileSync(path.join(dir, 'other.d.ts'), 'export declare const Foo: number;\n');

    const result = resolveIn(dir, 'Foo');

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(candidate => candidate.text).sort(), [
      'export declare const Foo: number;',
      'export declare function Foo(): void;',
    ]);
  });
});

describe('resolveIn: direct hits with unresolved named re-export siblings', () => {
  it('abstains when a same-file named re-export points to a missing relative file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-named-missing-relative-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-named-missing-relative',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare function Foo(): void;\nexport { Foo } from "./missing.js";\n');

    const result = resolveIn(dir, 'Foo');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 1);
  });

  it('abstains when a same-file named self-package re-export cannot be resolved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-named-missing-self-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-named-missing-self',
      version: '1.0.0',
      types: './index.d.ts',
      exports: {
        '.': { types: './index.d.ts' },
      },
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export declare function Foo(): void;\nexport { Foo } from "fixture-resolve-named-missing-self/feature";\n',
    );

    const result = resolveIn(dir, 'Foo');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 1);
  });

  it('resolves when a same-file named re-export sibling resolves and agrees', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-named-agreement-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-named-agreement',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare function Foo(): void;\nexport { Foo } from "./other.js";\n');
    fs.writeFileSync(path.join(dir, 'other.d.ts'), 'export declare function Foo(): void;\n');

    const result = resolveIn(dir, 'Foo');

    assert.equal(result.status, 'resolved');
    assert.equal(result.decl.file, 'index.d.ts');
    assert.equal(result.reason, undefined);
  });
});

describe('resolveIn: explicit named re-exports with unresolved star siblings', () => {
  function explicitNamedWithExternalStarFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-explicit-named-star-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-explicit-named-star',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export { Foo } from "./foo.js";\nexport * from "external-package";\n',
    );
    fs.writeFileSync(path.join(dir, 'foo.d.ts'), 'export declare function Foo(): void;\n');
    return dir;
  }

  it('resolves an explicit local named re-export despite an unresolved external star sibling', () => {
    const result = resolveIn(explicitNamedWithExternalStarFixture(), 'Foo');

    assert.equal(result.status, 'resolved');
    assert.equal(result.decl.file, 'foo.d.ts');
    assert.equal(result.decl.text, 'export declare function Foo(): void;');
  });

  it('still abstains for another name that the unresolved star could export', () => {
    const result = resolveIn(explicitNamedWithExternalStarFixture(), 'Other');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
  });
});

describe('resolveIn: root conditional entries', () => {
  it('does not choose a winner when import and require declarations conflict', () => {
    const result = resolveIn(conditionalEntryFixture({
      esm: 'export declare function conflict(input: string): string;\n',
      cjs: 'export declare const conflict: number;\n',
    }), 'conflict');

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.reason, 'ambiguous');
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(candidate => candidate.condition).sort(), [
      'exports.import',
      'exports.require',
    ]);
  });

  it('resolves when import and require declarations agree', () => {
    const result = resolveIn(conditionalEntryFixture({
      esm: 'export declare function shared(input: string): string;\n',
      cjs: '// CommonJS entry\nexport declare function shared(input: string): string;\n',
    }), 'shared');

    assert.equal(result.status, 'resolved');
    assert.equal(result.decl.kind, 'function');
    assert.equal(result.decl.text, 'export declare function shared(input: string): string;');
  });
});

describe('resolveIn: star export ambiguity', () => {
  function starCollisionFixture(explicit = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-star-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-star',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      [
        'export * from "./a.js";',
        'export * from "./b.js";',
        explicit ? 'export { shared } from "./a.js";' : '',
      ].filter(Boolean).join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export declare const shared: string;\n');
    fs.writeFileSync(path.join(dir, 'b.d.ts'), 'export declare const shared: number;\n');
    return dir;
  }

  it('does not confidently resolve duplicate star-export names', () => {
    const result = resolveIn(starCollisionFixture(), 'shared');
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(c => c.file).sort(), ['a.d.ts', 'b.d.ts']);
  });

  it('allows explicit re-exports to resolve a star-export collision', () => {
    const result = resolveIn(starCollisionFixture(true), 'shared');
    assert.equal(result.status, 'resolved');
    assert.equal(result.decl.file, 'a.d.ts');
  });

  it('does not dedupe away a file reached through different re-exported names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-seek-identity-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-seek-identity',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export * from "./a.js";\nexport * from "./b.js";\n');
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export { A as target } from "./shared.js";\n');
    fs.writeFileSync(path.join(dir, 'b.d.ts'), 'export { B as target } from "./shared.js";\n');
    fs.writeFileSync(
      path.join(dir, 'shared.d.ts'),
      'export declare const A: "a";\nexport declare const B: "b";\n',
    );

    const result = resolveIn(dir, 'target');

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(candidate => candidate.text).sort(), [
      'export declare const A: "a";',
      'export declare const B: "b";',
    ]);
  });

  it('does not dedupe byte-identical barrels from different directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-path-sensitive-dedupe-'));
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-path-sensitive-dedupe',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export * from "./a/barrel.js";\nexport * from "./b/barrel.js";\n');
    fs.writeFileSync(path.join(dir, 'a', 'barrel.d.ts'), 'export * from "./leaf.js";\n');
    fs.writeFileSync(path.join(dir, 'b', 'barrel.d.ts'), 'export * from "./leaf.js";\n');
    fs.writeFileSync(path.join(dir, 'a', 'leaf.d.ts'), 'export declare const target: "a";\n');
    fs.writeFileSync(path.join(dir, 'b', 'leaf.d.ts'), 'export declare const target: "b";\n');

    const result = resolveIn(dir, 'target');

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(candidate => candidate.text).sort(), [
      'export declare const target: "a";',
      'export declare const target: "b";',
    ]);
  });

  it('does not dedupe different declarations that collide under the content key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-hash-collision-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-hash-collision',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export * from "./a.js";\nexport * from "./b.js";\n');
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export declare const target: "Aa";\n');
    fs.writeFileSync(path.join(dir, 'b.d.ts'), 'export declare const target: "BB";\n');

    const result = resolveIn(dir, 'target');

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(candidate => candidate.text).sort(), [
      'export declare const target: "Aa";',
      'export declare const target: "BB";',
    ]);
  });

  it('abstains when a capped traversal cannot rule out a star-export conflict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-incomplete-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-incomplete',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    const stars = [];
    for (let i = 0; i < 801; i += 1) {
      stars.push(`export * from "./branch-${i}.js";`);
      const declaration = i === 0
        ? 'export declare const shared: "first";\n'
        : i === 800
          ? 'export declare const shared: "conflict-beyond-cap";\n'
          : `export declare const visible${i}: true;\n`;
      fs.writeFileSync(path.join(dir, `branch-${i}.d.ts`), declaration);
    }
    fs.writeFileSync(path.join(dir, 'index.d.ts'), `${stars.join('\n')}\n`);

    const result = resolveIn(dir, 'shared');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 800);
  });

  it('abstains when a relative star-export target cannot be resolved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-missing-relative-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-missing-relative',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export * from "./present.js";\nexport * from "./missing.js";\n',
    );
    fs.writeFileSync(path.join(dir, 'present.d.ts'), 'export declare const target: true;\n');

    const result = resolveIn(dir, 'target');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 2);
  });

  it('abstains when a self-package star-export target cannot be resolved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-resolve-missing-self-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-resolve-missing-self',
      version: '1.0.0',
      types: './index.d.ts',
      exports: {
        '.': { types: './index.d.ts' },
        './present': { types: './present.d.ts' },
      },
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export * from "fixture-resolve-missing-self/present";\nexport * from "fixture-resolve-missing-self/missing";\n',
    );
    fs.writeFileSync(path.join(dir, 'present.d.ts'), 'export declare const target: true;\n');

    const result = resolveIn(dir, 'target');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 2);
  });

  it('abstains when an external-package star sibling prevents proving uniqueness', () => {
    const result = resolveIn(unexaminedStarResolveFixture('external-package'), 'target');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 2);
  });

  it('abstains when a package-import star sibling prevents proving uniqueness', () => {
    const result = resolveIn(unexaminedStarResolveFixture('#some-import'), 'target');

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
    assert.equal(result.filesVisited, 2);
  });

  it('distinguishes an exact external re-export from an unexamined external star sibling', () => {
    const external = resolveIn(root('fixture-external'), 'thing');
    const incomplete = resolveIn(unexaminedStarResolveFixture('external-package'), 'target');

    assert.equal(external.status, 'not-resolved');
    assert.equal(external.reason, 'external_reexport');
    assert.deepEqual(external.external, { name: 'thing', src: 'some-external-pkg' });
    assert.equal(incomplete.status, 'not-resolved');
    assert.equal(incomplete.reason, 'resolution_incomplete');
    assert.equal(incomplete.external, undefined);
  });
});
