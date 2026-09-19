import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from '../src/serialize.js';
import { run } from '../src/cli.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fileSpec = name => `file:${path.join(fixtures, name)}`;

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

describe('serialize: bounds and shape', () => {
  it('caps declaration text, chain length, and candidates', () => {
    const result = serialize(
      {
        status: 'resolved',
        decl: {
          file: 'a.d.ts',
          line: 1,
          kind: 'function',
          overloads: 1,
          text: 'x'.repeat(5000),
          chain: Array.from({ length: 60 }, (_, i) => `./f${i}`),
          condition: 'types',
          flavor: 'd.ts',
        },
        filesVisited: 3,
        method: 'ts-ast-direct',
      },
      { name: 'p', version: '1.0.0', symbol: 's' },
    );
    assert.equal(result.declaration.text.length, 600);
    assert.equal(result.resolutionChain.length, 20);
    assert.ok(JSON.stringify(result).length < 12 * 1024);
  });

  it('keeps abstention output small and structured', () => {
    const result = serialize(
      { status: 'not-resolved', reason: 'no_types', filesVisited: 0 },
      { name: 'p', version: '1.0.0', symbol: 's' },
    );
    assert.deepEqual(result, {
      status: 'not_resolved',
      package: 'p',
      version: '1.0.0',
      symbol: 's',
      reason: 'no_types',
    });
  });

  it('uses snake_case not_resolved status', () => {
    const result = serialize({ status: 'ambiguous', reason: 'ambiguous', candidates: [], filesVisited: 2 }, {
      name: 'p',
      version: '1.0.0',
      symbol: 's',
    });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.reason, 'ambiguous');
  });
});

describe('cli: behavior contract', () => {
  it('resolves end to end from a file: spec with exit 0', async () => {
    const io = capture();
    const code = await run([fileSpec('fixture-barrel'), 'gadget'], { ...io, env: {} });
    assert.equal(code, 0);
    assert.equal(io.err, '');
    const parsed = JSON.parse(io.out);
    assert.equal(parsed.status, 'resolved');
    assert.equal(parsed.declaration.file, 'leaf.d.ts');
    assert.ok(!/\x1b\[[0-9;]*m/.test(io.out), 'no ANSI escapes in machine output');
  });

  it('returns exit 2 with structured abstention, nothing on stderr', async () => {
    const io = capture();
    const code = await run([fileSpec('fixture-notypes'), 'work'], { ...io, env: {} });
    assert.equal(code, 2);
    assert.equal(io.err, '');
    assert.deepEqual(JSON.parse(io.out), {
      status: 'not_resolved',
      package: 'fixture-notypes',
      version: '1.0.0',
      symbol: 'work',
      reason: 'no_types',
    });
  });

  it('distinguishes an external re-export from an incomplete external star sibling', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modsym-contract-external-star-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-contract-external-star',
      version: '1.0.0',
      types: './index.d.ts',
    }));
    fs.writeFileSync(
      path.join(dir, 'index.d.ts'),
      'export * from "./present.js";\nexport * from "external-package";\n',
    );
    fs.writeFileSync(path.join(dir, 'present.d.ts'), 'export declare const target: true;\n');

    const externalIo = capture();
    const incompleteIo = capture();
    const externalCode = await run([fileSpec('fixture-external'), 'thing'], { ...externalIo, env: {} });
    const incompleteCode = await run([`file:${dir}`, 'target'], { ...incompleteIo, env: {} });
    const external = JSON.parse(externalIo.out);
    const incomplete = JSON.parse(incompleteIo.out);

    assert.equal(externalCode, 2);
    assert.equal(external.reason, 'external_reexport');
    assert.equal(external.external, 'some-external-pkg');
    assert.equal(incompleteCode, 2);
    assert.equal(incomplete.reason, 'resolution_incomplete');
    assert.equal(Object.hasOwn(incomplete, 'external'), false);
  });

  it('rejects bad usage with exit 1 and a stderr line', async () => {
    for (const argv of [[], ['only-one'], ['a', 'b', 'c'], ['--bogus', 'x']]) {
      const io = capture();
      const code = await run(argv, { ...io, env: {} });
      assert.equal(code, 1);
      assert.match(io.err, /modsym: /);
    }
  });

  it('supports --help and --version', async () => {
    for (const flag of ['--help', '--version']) {
      const io = capture();
      const code = await run([flag], { ...io, env: {} });
      assert.equal(code, 0);
      assert.ok(io.out.length > 0);
      assert.equal(io.err, '');
    }
  });

  it('is deterministic across runs', async () => {
    const firstIo = capture();
    const secondIo = capture();
    const firstCode = await run([fileSpec('fixture-bundled'), 'make'], { ...firstIo, env: {} });
    const secondCode = await run([fileSpec('fixture-bundled'), 'make'], { ...secondIo, env: {} });

    assert.equal(firstCode, 0);
    assert.equal(secondCode, 0);
    assert.equal(firstIo.err, '');
    assert.equal(secondIo.err, '');
    assert.doesNotThrow(() => JSON.parse(firstIo.out));
    assert.doesNotThrow(() => JSON.parse(secondIo.out));
    assert.equal(firstIo.out, secondIo.out);
  });
});
