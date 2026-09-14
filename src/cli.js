import fs from 'node:fs';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, listPackageExports, resolvePackageSymbol } from './index.js';

export const EXIT_OK = 0;
export const EXIT_UNRESOLVED = 2;
export const EXIT_ERROR = 1;

/**
 * CLI adapter: `modsym <package-spec> <symbol>` or
 * `modsym <package-spec> --list [--match <text>] [--limit <n>]`.
 *
 * - JSON object on stdout, always (resolved, ambiguous, or not_resolved).
 * - Operational errors as one line on stderr, no stack traces by default.
 * - Exit codes: 0 resolved · 2 abstention (not_resolved/ambiguous) ·
 *   1 usage or operational failure.
 * - No colors, no paging, no interaction, no extra logging.
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`modsym: ${err.message}\n`);
    stderr.write(`${usageText()}\n`);
    return EXIT_ERROR;
  }
  if (args.help) {
    stdout.write(`${helpText()}\n`);
    return EXIT_OK;
  }
  if (args.version) {
    stdout.write(`${args.versionString}\n`);
    return EXIT_OK;
  }
  let result;
  try {
    if (args.mode === 'list') {
      result = await listPackageExports(args.spec, {
        packageCache: env.MODSYM_CACHE || undefined,
        match: args.match,
        limit: args.limit,
      });
    } else {
      result = await resolvePackageSymbol(args.spec, args.symbol, {
        packageCache: env.MODSYM_CACHE || undefined,
      });
    }
  } catch (err) {
    if (err && err.operational) {
      stderr.write(`modsym: ${err.message}\n`);
    } else {
      stderr.write(`modsym: internal error${env.MODSYM_DEBUG ? `: ${err?.stack || err}` : ''}\n`);
    }
    return EXIT_ERROR;
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'resolved' || result.status === 'listed' ? EXIT_OK : EXIT_UNRESOLVED;
}

function parseArgs(argv) {
  const positionals = [];
  let help = false;
  let version = false;
  let list = false;
  let match;
  let limit;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--version' || arg === '-V') version = true;
    else if (arg === '--list') list = true;
    else if (arg === '--match') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--match requires <text>');
      match = value;
    } else if (arg === '--limit') {
      const value = argv[++i];
      if (!value) throw new Error('--limit requires <n>');
      limit = parseLimit(value);
    }
    else if (arg.startsWith('-')) throw new Error(`unknown option ${JSON.stringify(arg)}`);
    else positionals.push(arg);
  }
  if (help || version) return { help, version, versionString: packageVersion() };
  if (list) {
    if (positionals.length !== 1) {
      throw new Error(`--list expects exactly one <package-spec>, got ${positionals.length} positional argument(s)`);
    }
    const [spec] = positionals;
    if (!spec.trim()) throw new Error('package spec must not be empty');
    return { mode: 'list', spec, match, limit };
  }
  if (match !== undefined) throw new Error('--match requires --list');
  if (limit !== undefined) throw new Error('--limit requires --list');
  if (positionals.length !== 2) {
    throw new Error(`expected <package-spec> <symbol>, got ${positionals.length} argument(s)`);
  }
  const [spec, symbol] = positionals;
  if (!spec.trim()) throw new Error('package spec must not be empty');
  if (!symbol.trim()) throw new Error('symbol must not be empty');
  return { mode: 'resolve', spec, symbol };
}

function parseLimit(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  return parsed;
}

function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (pkg && typeof pkg.version === 'string') return `modsym ${pkg.version}`;
  } catch {
    // fall through
  }
  return 'modsym 0.0.0-unknown';
}

function helpText() {
  return [
    'modsym — resolve an npm package symbol to its published TypeScript declaration.',
    '',
    usageText(),
    '',
    '  modsym zod string',
    '  modsym zod@4.5.4 string',
    '  modsym @ai-sdk/openai@4.0.60 createOpenAI',
    '  modsym zod@4.5.4 --list --match schema',
    '',
    'Prints one JSON object to stdout. Exit code 0 when resolved,',
    'or listed; 2 when the answer is not_resolved or ambiguous; 1 on errors.',
    `List mode uses case-insensitive substring matching and defaults to ${DEFAULT_LIST_LIMIT} results.`,
    'Set MODSYM_CACHE to override the package cache directory.',
  ].join('\n');
}

function usageText() {
  return [
    'usage: modsym <package-spec> <symbol>',
    '       modsym <package-spec> --list [--match <text>] [--limit <n>]',
  ].join('\n');
}
