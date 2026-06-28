// scripts/check-syntax.mjs
// `node --check` every shipped JS file (except the vendored jszip). Part of the
// verifier — a syntax error must fail the loop before any other test runs.
// Dependency-free and cross-platform (runs the same on Windows PowerShell).

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'audits', 'test', 'scripts']);
const SKIP_FILES = new Set(['jszip.min.js']);

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (entry.endsWith('.js') && !SKIP_FILES.has(entry)) files.push(p);
  }
}
walk('.');

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f]);
    console.log('OK   ' + f);
  } catch (e) {
    console.error('FAIL ' + f);
    console.error(String(e.stderr || e.message));
    failed = 1;
  }
}
if (!files.length) {
  console.error('No JS files found to check.');
  failed = 1;
}
process.exit(failed);
