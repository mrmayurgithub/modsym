import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listExportsIn, listPackageExports } from '../src/index.js';
import { run } from '../src/cli.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const root = name => path.join(fixtures, name);
const fileSpec = name => `file:${root(name)}`;

function byName(result, name) {
  return result.exports.find(item => item.name === name);
}

function names(result) {
  return result.exports.map(item => item.name);
}

function capture() {
  let out = '';
  let err = '';
  return {
    stdout: { write: s => (out += s) },
    stderr: { write: s => (err += s) },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

function unexaminedStarListFixture(specifier) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-unexamined-star-'));
  const packageJson = {
    name: 'fixture-list-unexamined-star',
    version: '1.0.0',
    types: './index.d.ts',
  };
  if (specifier.startsWith('#')) packageJson.imports = { [specifier]: './hidden.d.ts' };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(
    path.join(dir, 'index.d.ts'),
    `export * from "./present.js";\nexport * from "${specifier}";\n`,
  );
  fs.writeFileSync(path.join(dir, 'present.d.ts'), 'export declare const visible: true;\n');
  if (specifier.startsWith('#')) {
    fs.writeFileSync(path.join(dir, 'hidden.d.ts'), 'export declare const hidden: true;\n');
  }
  return dir;
}

function conditionalListFixture({ esm, cjs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-conditional-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-list-conditional',
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

function missingAdvertisedListFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-missing-root-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-list-missing-root',
    version: '1.0.0',
    exports: { '.': { import: './import.mjs', require: './require.cjs' } },
  }));
  fs.writeFileSync(path.join(dir, 'require.d.cts'), 'export declare function Foo(): void;\n');
  return dir;
}

describe('listExportsIn: root public export surface', () => {
  it('lists direct declarations, export stars, barrels, renames, and aliases', () => {
    const result = listExportsIn(root('fixture-barrel'));
    assert.equal(result.status, 'listed');
    assert.deepEqual(names(result), ['Alias', 'Gizmo', 'Mode', 'gadget', 'singleton']);
    assert.deepEqual(byName(result, 'gadget'), {
      name: 'gadget',
      kind: 'function',
      file: 'leaf.d.ts',
      line: 1,
    });
    assert.equal(byName(result, 'WidgetOptions'), undefined);
  });

  it('lists same-file aliases without bulk-resolving each symbol', () => {
    const result = listExportsIn(root('fixture-bundled'));
    assert.deepEqual(names(result), ['Maker', 'MakerOptions', 'make', 'readyMade']);
    assert.deepEqual(byName(result, 'Maker'), {
      name: 'Maker',
      kind: 'interface',
      file: 'dist/index.d.ts',
      line: 7,
    });
  });

  it('lists imported then re-exported symbols and type re-exports', () => {
    const result = listExportsIn(root('fixture-importtrace'));
    assert.deepEqual(names(result), ['Widget', 'WidgetOptions']);
    assert.equal(byName(result, 'Widget').file, 'dist/types/widget.d.ts');
    assert.equal(byName(result, 'WidgetOptions').kind, 'interface');
  });

  it('lists namespace import aliases conservatively', () => {
    const result = listExportsIn(root('fixture-namespace'));
    assert.deepEqual(names(result), ['tool', 'toolkit']);
    assert.deepEqual(byName(result, 'tool'), { name: 'tool', kind: 'namespace' });
    assert.deepEqual(byName(result, 'toolkit'), { name: 'toolkit', kind: 'namespace' });
  });

  it('lists namespace re-exports without expanding their members', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-ns-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-namespace',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export * as tools from "./tools.js";\n');
    fs.writeFileSync(path.join(dir, 'tools.d.ts'), 'export declare function hammer(): void;\n');

    const result = listExportsIn(dir);
    assert.deepEqual(result.exports, [{ name: 'tools', kind: 'namespace' }]);
  });

  it('abstains when a namespace re-export target cannot be resolved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-missing-ns-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-missing-namespace',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export declare function Foo(): void;\nexport * as ns from "./missing.js";\n',
    );

    assert.deepEqual(listExportsIn(dir), {
      status: 'not-resolved',
      reason: 'resolution_incomplete',
      filesVisited: 1,
    });
  });

  it('abstains when named re-export metadata cannot be resolved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-missing-named-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-missing-named',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export declare function Foo(): void;\nexport { Bar } from "./missing.js";\n',
    );

    assert.deepEqual(listExportsIn(dir), {
      status: 'not-resolved',
      reason: 'resolution_incomplete',
      filesVisited: 1,
    });
  });

  it('lists external named re-exports but does not invent declaration metadata', () => {
    const result = listExportsIn(root('fixture-external'));
    assert.deepEqual(result.exports, [
      { name: 'local', kind: 'const', file: 'index.d.ts', line: 2 },
      { name: 'thing' },
    ]);
  });

  it('lists default exports under the public default name', () => {
    const result = listExportsIn(root('fixture-exportdefault'));
    assert.deepEqual(names(result), ['default']);
    assert.deepEqual(byName(result, 'default'), {
      name: 'default',
      kind: 'const',
      file: 'index.d.ts',
      line: 4,
    });
  });

  it('handles root conditional exports and default re-export metadata', () => {
    const result = listExportsIn(root('fixture-rootcond'));
    assert.deepEqual(names(result), ['Got', 'Options', 'default', 'got']);
    assert.deepEqual(byName(result, 'Options'), {
      name: 'Options',
      kind: 'class',
      file: 'dist/source/core/options.d.ts',
      line: 1,
    });
  });

  it('does not claim a complete list when conditional entries disagree', () => {
    const result = listExportsIn(conditionalListFixture({
      esm: 'export declare function conflict(): void;\n',
      cjs: 'export declare const conflict: number;\n',
    }));

    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
  });

  it('lists a conditional export when entries agree', () => {
    const result = listExportsIn(conditionalListFixture({
      esm: 'export declare function shared(): void;\n',
      cjs: '// CommonJS entry\nexport declare function shared(): void;\n',
    }));

    assert.deepEqual(result, {
      status: 'listed',
      scope: 'root',
      exports: [{ name: 'shared', kind: 'function' }],
      filesVisited: 2,
    });
  });

  it('follows self-package re-exports within the root surface', () => {
    const result = listExportsIn(root('fixture-self'));
    assert.deepEqual(names(result), ['StoreApi', 'create', 'createStore']);
    assert.equal(byName(result, 'StoreApi').file, 'vanilla.d.ts');
  });

  it('dedupes declaration flavor mirrors', () => {
    const result = listExportsIn(root('fixture-flavors'));
    assert.deepEqual(names(result), ['run']);
  });

  it('does not crawl package subpaths while listing root exports', () => {
    const result = listExportsIn(root('fixture-ambiguous'));
    assert.deepEqual(names(result), ['rootOnly']);
  });

  it('omits duplicate names that only arrive through conflicting star exports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-dupe-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-dupe',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export * from "./a.js";\nexport * from "./b.js";\n');
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export declare const shared: string;\n');
    fs.writeFileSync(path.join(dir, 'b.d.ts'), 'export declare const shared: number;\nexport declare const onlyB: number;\n');

    const result = listExportsIn(dir);
    assert.deepEqual(result.exports, [{ name: 'onlyB', kind: 'const', file: 'b.d.ts', line: 2 }]);
  });

  it('keeps explicit exports that resolve a star-export collision', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-dupe-explicit-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-dupe-explicit',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export * from "./a.js";\nexport * from "./b.js";\nexport { shared } from "./a.js";\n',
    );
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export declare const shared: string;\n');
    fs.writeFileSync(path.join(dir, 'b.d.ts'), 'export declare const shared: number;\n');

    const result = listExportsIn(dir);
    assert.deepEqual(result.exports, [{ name: 'shared', kind: 'const', file: 'a.d.ts', line: 1 }]);
  });

  it('truthfully abstains when no declaration entry is usable', () => {
    const result = listExportsIn(root('fixture-notypes'));
    assert.deepEqual(result, {
      status: 'not-resolved',
      reason: 'no_types',
      filesVisited: 0,
    });
  });

  it('abstains when a relative star-export target cannot be resolved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-missing-relative-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-missing-relative',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export * from "./present.js";\nexport * from "./missing.js";\n',
    );
    fs.writeFileSync(path.join(dir, 'present.d.ts'), 'export declare const visible: true;\n');

    assert.deepEqual(listExportsIn(dir), {
      status: 'not-resolved',
      reason: 'resolution_incomplete',
      filesVisited: 2,
    });
  });

  it('abstains when a self-package star-export target cannot be resolved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-missing-self-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-missing-self',
      version: '1.0.0',
      types: './index.d.ts',
      exports: {
        '.': { types: './index.d.ts' },
        './present': { types: './present.d.ts' },
      },
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export * from "fixture-list-missing-self/present";\nexport * from "fixture-list-missing-self/missing";\n',
    );
    fs.writeFileSync(path.join(dir, 'present.d.ts'), 'export declare const visible: true;\n');

    assert.deepEqual(listExportsIn(dir), {
      status: 'not-resolved',
      reason: 'resolution_incomplete',
      filesVisited: 2,
    });
  });

  it('abstains when an external-package star sibling is not examined', () => {
    assert.deepEqual(listExportsIn(unexaminedStarListFixture('external-package')), {
      status: 'not-resolved',
      reason: 'resolution_incomplete',
      filesVisited: 2,
    });
  });

  it('keeps list mode incomplete when an explicit named export has an external star sibling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-explicit-named-star-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-explicit-named-star',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export { Foo } from "./foo.js";\nexport * from "external-package";\n',
    );
    fs.writeFileSync(path.join(dir, 'foo.d.ts'), 'export declare function Foo(): void;\n');

    assert.deepEqual(listExportsIn(dir), {
      status: 'not-resolved',
      reason: 'resolution_incomplete',
      filesVisited: 1,
    });
  });

  it('abstains when a package-import star sibling is not examined', () => {
    assert.deepEqual(listExportsIn(unexaminedStarListFixture('#some-import')), {
      status: 'not-resolved',
      reason: 'resolution_incomplete',
      filesVisited: 2,
    });
  });

  it('abstains when one advertised conditional root entry is missing', () => {
    const result = listExportsIn(missingAdvertisedListFixture());
    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
  });

  it('lists agreeing conditional entries', () => {
    const result = listExportsIn(conditionalListFixture({
      esm: 'export declare function Foo(): void;\n',
      cjs: 'export declare function Foo(): void;\n',
    }));
    assert.equal(result.status, 'listed');
    assert.deepEqual(result.exports.map(item => item.name), ['Foo']);
  });

  it('lists name-only when a known entry merges with an unknown-metadata sibling', () => {
    const result = listExportsIn(conditionalListFixture({
      esm: 'export { Foo } from "external-package";\n',
      cjs: 'export declare function Foo(): void;\n',
    }));
    assert.equal(result.status, 'listed');
    assert.deepEqual(result.exports, [{ name: 'Foo' }]);
  });

  it('lists name-only regardless of merge order', () => {
    const fwd = listExportsIn(conditionalListFixture({
      esm: 'export { Foo } from "external-package";\n',
      cjs: 'export declare function Foo(): void;\n',
    }));
    const rev = listExportsIn(conditionalListFixture({
      esm: 'export declare function Foo(): void;\n',
      cjs: 'export { Foo } from "external-package";\n',
    }));
    assert.deepEqual(fwd.exports, [{ name: 'Foo' }]);
    assert.deepEqual(rev.exports, [{ name: 'Foo' }]);
  });

  it('retains metadata for two agreeing known entries', () => {
    const result = listExportsIn(conditionalListFixture({
      esm: 'export declare function Foo(): void;\n',
      cjs: 'export declare function Foo(): void;\n',
    }));
    assert.equal(result.status, 'listed');
    assert.equal(result.exports[0].name, 'Foo');
    assert.equal(result.exports[0].kind, 'function');
  });

  it('abstains on a genuine known conflict', () => {
    const result = listExportsIn(conditionalListFixture({
      esm: 'export declare function Foo(): void;\n',
      cjs: 'export declare const Foo: number;\n',
    }));
    assert.equal(result.status, 'not-resolved');
    assert.equal(result.reason, 'resolution_incomplete');
  });
});

describe('listPackageExports: filtering and bounds', () => {
  it('filters by case-insensitive substring before truncation', async () => {
    const result = await listPackageExports(fileSpec('fixture-bundled'), { match: 'ready', limit: 1 });
    assert.equal(result.status, 'listed');
    assert.equal(result.match, 'ready');
    assert.deepEqual(result.exports.map(item => item.name), ['readyMade']);
    assert.equal(result.total, 1);
    assert.equal(result.shown, 1);
    assert.equal(result.truncated, false);
  });

  it('bounds large export surfaces with total, shown, and truncated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-large-list',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      Array.from({ length: 120 }, (_, i) => `export declare const item${String(i).padStart(3, '0')}: number;`).join('\n'),
    );

    const result = await listPackageExports(`file:${dir}`);
    assert.equal(result.status, 'listed');
    assert.equal(result.total, 120);
    assert.equal(result.shown, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.exports.length, 100);
  });
});

describe('cli: list mode contract', () => {
  it('lists from the CLI with exit 0 and bounded JSON', async () => {
    const io = capture();
    const code = await run([fileSpec('fixture-barrel'), '--list', '--match', 'gAd', '--limit', '5'], { ...io, env: {} });
    assert.equal(code, 0);
    assert.equal(io.err, '');
    const parsed = JSON.parse(io.out);
    assert.equal(parsed.status, 'listed');
    assert.deepEqual(parsed.exports.map(item => item.name), ['gadget']);
  });

  it('returns exit 2 for list abstention', async () => {
    const io = capture();
    const code = await run([fileSpec('fixture-notypes'), '--list'], { ...io, env: {} });
    assert.equal(code, 2);
    assert.equal(io.err, '');
    assert.equal(JSON.parse(io.out).reason, 'no_types');
  });

  it('abstains instead of claiming a complete list when traversal is capped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-list-incomplete-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-list-incomplete',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    const stars = [];
    for (let i = 0; i < 801; i += 1) {
      stars.push(`export * from "./branch-${i}.js";`);
      fs.writeFileSync(
        path.join(dir, `branch-${i}.d.ts`),
        i === 800
          ? 'export declare const beyondTraversalCap: true;\n'
          : `export declare const visible${i}: true;\n`,
      );
    }
    fs.writeFileSync(path.join(dir, 'index.d.ts'), `${stars.join('\n')}\n`);

    const io = capture();
    const code = await run([`file:${dir}`, '--list'], { ...io, env: {} });

    assert.equal(code, 2);
    assert.equal(io.err, '');
    assert.deepEqual(JSON.parse(io.out), {
      status: 'not_resolved',
      package: 'fixture-list-incomplete',
      version: '1.0.0',
      scope: 'root',
      reason: 'resolution_incomplete',
      filesVisited: 800,
    });
  });

  it('rejects invalid list option combinations', async () => {
    for (const argv of [
      [fileSpec('fixture-barrel'), 'gadget', '--list'],
      [fileSpec('fixture-barrel'), '--match', 'gad'],
      [fileSpec('fixture-barrel'), '--list', '--limit', '-1'],
      [fileSpec('fixture-barrel'), '--list', '--limit', '501'],
    ]) {
      const io = capture();
      const code = await run(argv, { ...io, env: {} });
      assert.equal(code, 1);
      assert.match(io.err, /modsym: /);
    }
  });
});
