/// <reference lib="es2022" />
/**
 * Parity guard: the CLI must be a pure formatter over server/core.
 *
 * If a CLI handler ever recomputes something itself, its --json payload will drift
 * from the core result and this test fails. That is the whole point: the AST baseline
 * may not acquire a second implementation.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import Database = require('better-sqlite3');
import { Graph } from './core/graph';
import { buildSheetCard, diffScreens, findSimilar } from './core/analyze';
import { loadLabels } from './core/semantics';

const ROOT = resolve(__dirname, '..');
const DB = resolve(ROOT, 'data/rea-figma.sqlite');

let failures = 0;

function cli(args: string[]): unknown {
  const out = execFileSync('npx', ['tsx', 'server/query.ts', ...args, '--json', '--db', DB], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out) as { ok: boolean; data?: unknown; error?: unknown };
  if (!parsed.ok) throw new Error('cli error: ' + JSON.stringify(parsed.error));
  return parsed.data;
}

function same(label: string, a: unknown, b: unknown): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) {
    console.log('  ok    ' + label);
    return;
  }
  failures += 1;
  console.log('  FAIL  ' + label);
  const la = sa.split(',');
  const lb = sb.split(',');
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) {
      console.log('        first diff at token ' + i + ': cli=' + String(la[i]).slice(0, 60) + ' core=' + String(lb[i]).slice(0, 60));
      break;
    }
  }
}

function main(): void {
  if (!existsSync(DB)) {
    console.log('parity  skipped: no live db at ' + DB);
    console.log('        (run the Figma extraction first; see README quick start)');
    return;
  }
  const probe = new Database(DB, { readonly: true, fileMustExist: true });
  const picked = probe.prepare('SELECT id FROM nodes ORDER BY page_id, id LIMIT 2').all() as Array<{ id: string }>;
  probe.close();
  if (picked.length < 2) {
    console.log('parity  skipped: need at least 2 nodes in ' + DB);
    return;
  }
  const ID = picked[0].id;
  const OTHER = picked[1].id;
  console.log('parity  db=' + DB + ' ids=' + ID + ',' + OTHER);
  const g = new Graph(DB);
  const labels = (() => {
    try {
      return loadLabels(resolve(ROOT, 'labels/style.json')).labels;
    } catch {
      return [];
    }
  })();

  same('sheet ' + ID, cli(['sheet', ID]), buildSheetCard(g, DB, ID, { labels }));
  same('diff ' + ID + ' vs ' + OTHER, cli(['diff', ID, OTHER]), diffScreens(g, DB, ID, OTHER));
  same('find ' + ID, cli(['find', ID, '--top', '5']), findSimilar(g, DB, ID, 5));

  console.log('');
  if (failures > 0) {
    console.log('RESULT: FAIL (' + failures + ')');
    process.exit(1);
  }
  console.log('RESULT: OK — CLI output is byte-identical to core');
}

main();
