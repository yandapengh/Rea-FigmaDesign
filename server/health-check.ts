/// <reference lib="es2022" />
/**
 * Stage 3 health check: read-only integrity audit for a Rea-FigmaDesign graph.
 *
 * Usage:
 *   npx tsx server/health-check.ts                 # newest data/<file>/graph.sqlite
 *   npx tsx server/health-check.ts --db data/.../graph.sqlite
 *   npx tsx server/health-check.ts --json
 *   npx tsx server/health-check.ts --fix           # only repairs derived counters
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AstGraphDB } from './db';
import { runHealthChecks } from './core/health';

const ROOT = resolve(__dirname, '..');
const argv = process.argv.slice(2);
let dbPath = process.env.REA_DB_PATH ? resolve(ROOT, process.env.REA_DB_PATH) : '';
let json = false;
let fix = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--json') json = true;
  else if (a === '--fix') fix = true;
  else if (a === '--db') dbPath = resolve(ROOT, argv[++i] ?? '');
  else if (!a.startsWith('--')) dbPath = resolve(ROOT, a);
}

if (!dbPath) dbPath = AstGraphDB.resolveLatestGraphDb(ROOT) ?? '';
if (!dbPath || !existsSync(dbPath)) {
  console.error('no database found; run the plugin export first');
  process.exit(1);
}

const payload = runHealthChecks(dbPath, fix);
if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('=== Rea-FigmaDesign health check ===');
  console.log('db      ' + payload.db);
  console.log('file    ' + (payload.file ? payload.file.file_name : '?') + '  (' + (payload.file ? payload.file.file_key : '?') + ')');
  console.log('nodes   ' + payload.nodes.toLocaleString('en-US') + ' · pages ' + payload.pages + ' (DONE ' + payload.done + ' / SKIPPED ' + payload.skipped + ')');
  console.log('');
  for (const c of payload.checks) console.log((c.ok ? '  ok    ' : '  FAIL  ') + c.label + ' — ' + c.detail);
  if (payload.duplicateNames.length > 0) {
    console.log('  note  ' + payload.duplicateNames.length + ' 組同名頁面（本機檔身份風險）: ' + payload.duplicateNames.slice(0, 3).map((d) => d.page_name + '×' + d.c).join(', '));
  }
  console.log('');
  console.log(payload.failed === 0 ? 'RESULT: OK — 全量資料一致' : 'RESULT: FAIL (' + payload.failed + ')');
}

process.exit(payload.failed === 0 ? 0 : 1);
