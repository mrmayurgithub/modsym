#!/usr/bin/env node
// Generates deterministic fixture packages under test/fixtures/.
// Each fixture is a tiny synthetic npm package exercising one export idiom.
// Re-run with `node scripts/gen-fixtures.mjs`; output is checked in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

function pkg(name, packageJson, files) {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries({ 'package.json': JSON.stringify(packageJson, null, 2) + '\n', ...files })) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// 1. barrel: multi-hop chain with a rename in the middle (zod-style).
pkg('fixture-barrel', { name: 'fixture-barrel', version: '1.0.0', types: './index.d.ts' }, {
  'index.d.ts': `export * from "./mid.js";\n`,
  'mid.d.ts': `export { widget as gadget } from "./leaf.js";\nexport * from "./kinds.js";\n`,
  'leaf.d.ts': `export declare function widget(opts?: WidgetOptions): Widget;\nexport interface WidgetOptions {\n  size?: number;\n}\nexport interface Widget {\n  render(): string;\n}\n`,
  'kinds.d.ts': `export declare class Gizmo {\n  constructor(name: string);\n}\nexport type Alias = string | number;\nexport declare const singleton: Gizmo;\nexport declare enum Mode {\n  Fast = "fast",\n  Slow = "slow"\n}\n`,
});

// 2. bundled: single file, bare declares + bottom export list, overloads (ai-sdk-style).
pkg('fixture-bundled', { name: 'fixture-bundled', version: '1.0.0', types: './dist/index.d.ts' }, {
  'dist/index.d.ts': [
    'interface MakerOptions {',
    '  prefix?: string;',
    '}',
    'declare function make(options?: MakerOptions): Maker;',
    'declare function make(name: string, options?: MakerOptions): Maker;',
    'declare const readyMade: Maker;',
    'interface Maker {',
    '  build(): string;',
    '}',
    'export { make, readyMade, type Maker, type MakerOptions };',
    '',
  ].join('\n'),
});

// 3. big Exports map + per-subpath files (date-fns-style, small scale).
{
  const files = {};
  const names = ['alpha', 'beta', 'gamma', 'delta'];
  for (const n of names) {
    files[`${n}.d.ts`] = `export declare function ${n}(input: string): string;\n`;
  }
  files['index.d.ts'] = names.map(n => `export * from "./${n}.ts";`).join('\n') + '\n';
  const exports = { '.': { import: { types: './index.d.ts', default: './index.js' }, require: { types: './index.d.cts', default: './index.cjs' } } };
  for (const n of names) exports[`./${n}`] = { import: { types: `./${n}.d.ts`, default: `./${n}.js` } };
  pkg('fixture-exports', {
    name: 'fixture-exports', version: '1.0.0',
    type: 'module', main: 'index.js', exports,
  }, { ...files, 'index.d.cts': files['index.d.ts'] });
}

// 4. self-package re-exports (zustand-style).
pkg('fixture-self', {
  name: 'fixture-self', version: '1.0.0', type: 'module',
  exports: {
    '.': { types: './index.d.ts', default: './index.js' },
    './vanilla': { types: './vanilla.d.ts', default: './vanilla.js' },
    './react': { types: './react.d.ts', default: './react.js' },
    './package.json': './package.json',
  },
}, {
  'index.d.ts': `export * from 'fixture-self/vanilla';\nexport * from 'fixture-self/react';\n`,
  'vanilla.d.ts': `export declare const createStore: CreateStore;\nexport interface StoreApi<T> {\n  getState(): T;\n}\n`,
  'react.d.ts': `export declare const create: Create;\n`,
});

// 5. root-conditional exports, no "." key (got-style).
pkg('fixture-rootcond', {
  name: 'fixture-rootcond', version: '1.0.0', type: 'module',
  exports: { types: './dist/source/index.d.ts', default: './dist/source/index.js' },
}, {
  'dist/source/index.d.ts': `declare const got: Got;\nexport default got;\nexport { got };\nexport { default as Options } from './core/options.js';\nexport interface Got {\n  (url: string): Promise<string>;\n}\n`,
  'dist/source/core/options.d.ts': `export default class Options {\n  timeout?: number;\n}\n`,
});

// 6. root index.d.ts fallback, no types/exports at all (yup-style mega list + aliases).
pkg('fixture-fallback', { name: 'fixture-fallback', version: '1.0.0', main: 'index.js' }, {
  'index.d.ts': [
    'declare function create$1(): TupleSchema;',
    'declare function create$2(): ArraySchema;',
    'interface TupleSchema { kind: "tuple"; }',
    'interface ArraySchema { kind: "array"; }',
    'export interface Schema { validate(value: unknown): boolean; }',
    'export { create$1 as tuple, create$2 as array, Schema };',
    '',
  ].join('\n'),
});

// 7. default aliases (ioredis-style).
pkg('fixture-defalias', {
  name: 'fixture-defalias', version: '1.0.0', types: './built/index.d.ts',
}, {
  'built/index.d.ts': `export { default as Redis } from "./Redis";\nexport { default as Cluster } from "./cluster";\nexport { RedisOptions } from "./redis/RedisOptions";\n`,
  'built/Redis.d.ts': `export default class Redis {\n  connect(): Promise<void>;\n}\n`,
  'built/cluster/index.d.ts': `declare class Cluster {\n  readonly nodes: string[];\n}\nexport default Cluster;\n`,
  'built/redis/RedisOptions.d.ts': `export interface RedisOptions {\n  host?: string;\n}\n`,
});

// 8. minified rename chain (swr-style).
pkg('fixture-minified', {
  name: 'fixture-minified', version: '1.0.0', types: './dist/index.d.ts',
}, {
  'dist/index.d.ts': `export { L as mutate, Q as useThing, T as Config } from './types-abc.js';\n`,
  'dist/types-abc.d.ts': `declare const L: Mutator;\nexport { L as mutateAlias };\ndeclare const mutate: ScopedMutator;\nexport { mutate as L };\ninterface ScopedMutator {\n  (key: string): void;\n}\ninterface Mutator {\n  (key: string): void;\n}\n`,
});

// 9. imported-symbol re-export (hono-style).
pkg('fixture-importtrace', {
  name: 'fixture-importtrace', version: '1.0.0', types: './dist/types/index.d.ts',
}, {
  'dist/types/index.d.ts': `import { Widget } from './widget';\nexport { Widget };\nexport type { WidgetOptions } from './widget';\n`,
  'dist/types/widget.d.ts': `export declare class Widget {\n  constructor(name: string);\n}\nexport interface WidgetOptions {\n  color?: string;\n}\n`,
});

// 10. namespace re-export (zod `z`-style).
pkg('fixture-namespace', {
  name: 'fixture-namespace', version: '1.0.0', types: './index.d.ts',
}, {
  'index.d.ts': `import * as tool from "./tool.js";\nexport { tool };\nexport { tool as toolkit };\n`,
  'tool.d.ts': `export declare function hammer(nail: string): void;\n`,
});

// 11. declaration flavor mirrors (byte-identical ESM/CJS mirrors).
{
  const barrel = `export * from "./core.js";\n`;
  const core = `export declare function run(mode: string): void;\n`;
  pkg('fixture-flavors', {
    name: 'fixture-flavors', version: '1.0.0', type: 'module',
    types: './index.d.ts',
    exports: {
      '.': { types: './index.d.ts', import: './index.js', require: './index.cjs' },
      './package.json': './package.json',
    },
  }, {
    'index.d.ts': barrel,
    'core.d.ts': core,
    'index.d.mts': barrel,
    'core.d.mts': core,
    'index.d.cts': barrel,
    'core.d.cts': core,
  });
}

// 12. no declarations at all.
pkg('fixture-notypes', { name: 'fixture-notypes', version: '1.0.0', main: 'index.js' }, {
  'index.js': `module.exports = function work() { return 1; };\n`,
});

// 13. external re-export (vitest/bson-style).
pkg('fixture-external', {
  name: 'fixture-external', version: '1.0.0', types: './index.d.ts',
}, {
  'index.d.ts': `export { thing } from 'some-external-pkg';\nexport declare const local: number;\n`,
});

// 14. genuinely ambiguous bare symbol (effect-style subpath modules).
{
  const files = {
    'dist/root.d.ts': `export declare const rootOnly: number;\n`,
  };
  const exports = { '.': { types: './dist/root.d.ts', default: './dist/root.js' } };
  for (const mod of ['alpha', 'beta']) {
    files[`dist/${mod}.d.ts`] = `export declare const shared: ${mod === 'alpha' ? 'string' : 'number'};\n`;
    exports[`./${mod}`] = { types: `./dist/${mod}.d.ts`, default: `./dist/${mod}.js` };
  }
  files['dist/only.d.ts'] = `export declare function lonely(): void;\n`;
  exports['./only'] = { types: './dist/only.d.ts', default: './dist/only.js' };
  pkg('fixture-ambiguous', { name: 'fixture-ambiguous', version: '1.0.0', exports }, files);
}

// 15. pg-style trap: subpath maps to JS only; a .mjs file mentions the symbol.
pkg('fixture-jstrap', {
  name: 'fixture-jstrap', version: '1.0.0',
  exports: {
    '.': { default: './esm/index.mjs' },
    './extra': { default: './esm/extra.mjs' },
  },
}, {
  'esm/index.mjs': `export const Client = 5;\nexport const Pool = 6;\n`,
  'esm/extra.mjs': `export const Helper = 7;\n`,
});

// 16. export = (pino-style, with declaration merging).
pkg('fixture-exporteq', {
  name: 'fixture-exporteq', version: '1.0.0', main: 'index.js', types: './index.d.ts',
}, {
  'index.d.ts': `declare namespace tool {\n  interface Options {\n    verbose?: boolean;\n  }\n}\ndeclare function tool(options?: tool.Options): tool.Handle;\ndeclare namespace tool {\n  interface Handle {\n    close(): void;\n  }\n}\nexport = tool;\n`,
});

// 17. export default identifier (axios-style).
pkg('fixture-exportdefault', {
  name: 'fixture-exportdefault', version: '1.0.0', types: './index.d.ts',
}, {
  'index.d.ts': `interface ClientStatic {\n  (url: string): Promise<string>;\n}\ndeclare const client: ClientStatic;\nexport default client;\n`,
});

// 18. default-only exposure (swr/mutation-style subpath).
pkg('fixture-defaultonly', {
  name: 'fixture-defaultonly', version: '1.0.0',
  exports: {
    '.': { types: './index.d.ts', default: './index.js' },
    './thing': { types: './thing.d.ts', default: './thing.js' },
  },
}, {
  'index.d.ts': `export declare const other: number;\n`,
  'thing.d.ts': `declare const thing: Thing;\ninterface Thing {\n  run(): void;\n}\nexport { thing as default };\n`,
});

// 19. ambient module (mongoose-style).
pkg('fixture-ambient', {
  name: 'fixture-ambient', version: '1.0.0', main: './index.js', types: './types/index.d.ts',
}, {
  'types/index.d.ts': `declare module 'fixture-ambient' {\n  export class Shape {\n    area(): number;\n  }\n  export function makeShape(): Shape;\n}\n`,
});

// 20. export-import-equals (winston-style, unsupported).
pkg('fixture-impeq', {
  name: 'fixture-impeq', version: '1.0.0', main: './index.js', types: './index.d.ts',
}, {
  'index.d.ts': `import * as fmt from './format';\ndeclare namespace lib {\n  export import format = fmt;\n}\ndeclare function lib(): void;\nexport = lib;\n`,
  'format.d.ts': `export declare function pretty(input: string): string;\n`,
});

console.log(`fixtures written to ${root}`);
