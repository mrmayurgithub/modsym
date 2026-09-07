import fs from 'node:fs';
import { resolvePackageSymbol } from './index.js';

export const EXIT_OK = 0;
export const EXIT_UNRESOLVED = 2;
export const EXIT_ERROR = 1;

/**
 * CLI adapter: `modsym <package-spec> <symbol>`.
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
    stderr.write('usage: modsym <package-spec> <symbol>\n');
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
    result = await resolvePackageSymbol(args.spec, args.symbol, {
      packageCache: env.MODSYM_CACHE || undefined,
    });
  } catch (err) {
    if (err && err.operational) {
      stderr.write(`modsym: ${err.message}\n`);
    } else {
      stderr.write(`modsym: internal error${env.MODSYM_DEBUG ? `: ${err?.stack || err}` : ''}\n`);
    }
    return EXIT_ERROR;
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'resolved' ? EXIT_OK : EXIT_UNRESOLVED;
}

function parseArgs(argv) {
  const positionals = [];
  let help = false;
  let version = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--version' || arg === '-V') version = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${JSON.stringify(arg)}`);
    else positionals.push(arg);
  }
  if (help || version) return { help, version, versionString: packageVersion() };
  if (positionals.length !== 2) {
    throw new Error(`expected <package-spec> <symbol>, got ${positionals.length} argument(s)`);
  }
  const [spec, symbol] = positionals;
  if (!spec.trim()) throw new Error('package spec must not be empty');
  if (!symbol.trim()) throw new Error('symbol must not be empty');
  return { spec, symbol };
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
    'usage: modsym <package-spec> <symbol>',
    '',
    '  modsym zod string',
    '  modsym zod@4.5.4 string',
    '  modsym @ai-sdk/openai@4.0.60 createOpenAI',
    '',
    'Prints one JSON object to stdout. Exit code 0 when resolved,',
    '2 when the answer is not_resolved or ambiguous, 1 on errors.',
    'Set MODSYM_CACHE to override the package cache directory.',
  ].join('\n');
}
