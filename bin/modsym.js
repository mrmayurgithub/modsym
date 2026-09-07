#!/usr/bin/env node
import { run } from '../src/cli.js';

const code = await run(process.argv.slice(2));
process.exit(code);
