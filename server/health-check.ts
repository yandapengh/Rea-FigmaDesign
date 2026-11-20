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

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');

const ROOT = resolve(__dirname, '..');
const argv = process.argv.slice(2);
let dbPath = process.env.REA_DB_PATH ? resolve(ROOT, process.env.REA_DB_PATH) : '';
let json = false;
let fix = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--json') json = true;
  else if (a === '--fix') fix = true;
  else if (a === '--db') { dbPath = resolve(ROOT, argv[++i] ?? ''); }
  else if (!a.startsWith('--')) dbPath = resolve(ROOT, a);
}

function latestDb(): string | null {
  const dataRoot = join(ROOT, 'data');
  if (!existsSync(dataRoot)) return null;
  let best: string | null = null;
  let bestTime = 0;
  for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(dataRoot, entry.name, 'graph.sqlite');
    if (!existsSync(p)) continue;
    const t = statSync(p).mtimeMs;
    if (t > bestTime) { bestTime = t; best = p; }
  }
  return best;
}

if (!dbPath) dbPath = latestDb() ?? '';
if (!dbPath || !existsSync(dbPath)) {
  console.error('no database found; run the plugin export first');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: !fix, fileMustExist: true });
const fileKey = (db.prepare('SELECT file_key FROM file_meta ORDER BY extracted_at DESC LIMIT 1').get() as { file_key: string } | undefined)?.file_key ?? '';
const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
const all = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

const meta = one<{ file_key: string; file_name: string; page_count: number; total_nodes: number }>('SELECT file_key, file_name, page_count, total_nodes FROM file_meta ORDER BY extracted_at DESC LIMIT 1');
const nodes = one<{ c: number }>('SELECT COUNT(*) AS c FROM nodes WHERE file_key = ?', fileKey).c;
const pages = all<{ page_id: string; page_name: string; status: string; node_count: number; actual: number }>(
  'SELECT p.page_id, p.page_name, p.status, p.node_count, (SELECT COUNT(*) FROM nodes n WHERE n.file_key = p.file_key AND n.page_id = p.page_id) AS actual FROM pages p WHERE p.file_key = ? ORDER BY p.page_index', fileKey);
const staging = one<{ c: number }>('SELECT COUNT(*) AS c FROM nodes_staging WHERE file_key = ?', fileKey).c;
const syncing = pages.filter((p) => p.status === 'SYNCING').length;
const donePages = pages.filter((p) => p.status === 'DONE');
const skipPages = pages.filter((p) => p.status === 'SKIPPED');
const doneMismatch = donePages.filter((p) => p.node_count !== p.actual);
const doneEmpty = donePages.filter((p) => p.actual === 0);
const orphanPage = one<{ c: number }>('SELECT COUNT(*) AS c FROM nodes n LEFT JOIN pages p ON p.file_key = n.file_key AND p.page_id = n.page_id WHERE n.file_key = ? AND p.page_id IS NULL', fileKey).c;
const orphanParent = one<{ c: number }>('SELECT COUNT(*) AS c FROM nodes n LEFT JOIN nodes p ON p.file_key = n.file_key AND p.id = n.parent_id WHERE n.file_key = ? AND n.parent_id IS NOT NULL AND p.id IS NULL', fileKey).c;
const compMismatch = one<{ c: number }>('SELECT COUNT(*) AS c FROM components WHERE file_key <> ?', fileKey).c;
const varMismatch = one<{ c: number }>('SELECT COUNT(*) AS c FROM variables WHERE file_key <> ?', fileKey).c;
const dupNames = all<{ page_name: string; c: number }>('SELECT page_name, COUNT(*) AS c FROM pages WHERE file_key = ? GROUP BY page_name HAVING c > 1', fileKey);
const sumCounts = donePages.reduce((acc, p) => acc + p.actual, 0) + skipPages.reduce((acc, p) => acc + p.actual, 0);
const pageCountMismatch = meta ? pages.length - meta.page_count : 0;
const totalMismatch = meta ? meta.total_nodes - nodes : 0;

interface Check { id: string; label: string; ok: boolean; detail: string; critical: boolean }
const checks: Check[] = [
  { id: 'file_meta', label: 'file_meta 存在且只有一個檔案', ok: Boolean(meta), detail: meta ? meta.file_name + ' (' + meta.file_key + ')' : 'missing', critical: true },
  { id: 'staging', label: '暫存表為 0 筆', ok: staging === 0, detail: staging + ' rows', critical: true },
  { id: 'syncing', label: '沒有卡在 SYNCING 的頁', ok: syncing === 0, detail: syncing + ' pages', critical: true },
  { id: 'orphan_page', label: '每個節點都屬於存在的頁', ok: orphanPage === 0, detail: orphanPage + ' nodes', critical: true },
  { id: 'orphan_parent', label: '沒有孤兒父節點', ok: orphanParent === 0, detail: orphanParent + ' nodes', critical: true },
  { id: 'done_empty', label: 'DONE 頁都有節點', ok: doneEmpty.length === 0, detail: doneEmpty.map((p) => p.page_name).join(', ') || '0 pages', critical: true },
  { id: 'page_node_count', label: 'pages.node_count 與實際節點一致', ok: doneMismatch.length === 0, detail: doneMismatch.length === 0 ? pages.length + ' pages' : doneMismatch.map((p) => p.page_name + ' ' + p.node_count + '≠' + p.actual).slice(0, 3).join('; ') + ' (' + doneMismatch.length + ')', critical: true },
  { id: 'total_nodes', label: 'file_meta.total_nodes 與 nodes 一致', ok: totalMismatch === 0, detail: 'meta ' + (meta ? meta.total_nodes : 0) + ' vs actual ' + nodes, critical: true },
  { id: 'page_count', label: 'pages 筆數與 file_meta.page_count 一致', ok: pageCountMismatch === 0, detail: pages.length + ' vs ' + (meta ? meta.page_count : 0), critical: false },
  { id: 'file_scope', label: 'components/variables 屬於同一檔案', ok: compMismatch === 0 && varMismatch === 0, detail: compMismatch + ' / ' + varMismatch, critical: true },
  { id: 'sum', label: 'DONE+SKIPPED 節點總和 = nodes', ok: sumCounts === nodes, detail: sumCounts + ' vs ' + nodes, critical: true },
];

if (fix) {
  const now = new Date().toISOString();
  db.pragma('journal_mode = WAL');
  const txn = db.transaction(() => {
    for (const p of pages) db.prepare('UPDATE pages SET node_count = ? WHERE file_key = ? AND page_id = ?').run(p.actual, fileKey, p.page_id);
    db.prepare('UPDATE file_meta SET total_nodes = ?, updated_at = ? WHERE file_key = ?').run(nodes, now, fileKey);
  });
  txn();
}

const failed = checks.filter((c) => !c.ok && c.critical);
const payload = { db: dbPath, file: meta, nodes, pages: pages.length, done: donePages.length, skipped: skipPages.length, staging, checks, failed: failed.length, duplicateNames: dupNames };
if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('=== Rea-FigmaDesign health check ===');
  console.log('db      ' + dbPath);
  console.log('file    ' + (meta ? meta.file_name : '?') + '  (' + (meta ? meta.file_key : '?') + ')');
  console.log('nodes   ' + nodes.toLocaleString('en-US') + ' · pages ' + pages.length + ' (DONE ' + donePages.length + ' / SKIPPED ' + skipPages.length + ')');
  console.log('');
  for (const c of checks) console.log((c.ok ? '  ok    ' : '  FAIL  ') + c.label + ' — ' + c.detail);
  if (dupNames.length > 0) console.log('  note  ' + dupNames.length + ' 組同名頁面（本機檔身份風險）: ' + dupNames.slice(0, 3).map((d) => d.page_name + '×' + d.c).join(', '));
  console.log('');
  console.log(failed.length === 0 ? 'RESULT: OK — 全量資料一致' : 'RESULT: FAIL (' + failed.length + ')');
}

process.exit(failed.length === 0 ? 0 : 1);
