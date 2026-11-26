/// <reference lib="es2022" />
/** Category report: list all categories, or report one category by Figma page with node IDs. */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { AstGraphDB } from './db';
import { resolveProject } from './core/projects';
import { categoryReportV2, summarizeCategoriesV2, tryLoadScreenLabelsV2 } from './core/semantics';

const ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);
let listMode = false;
let jsonMode = false;
let noFile = false;
let outFlag = '';
let dbFlag = '';
let projectFlag = '';
let category = '';

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--list') listMode = true;
  else if (a === '--json') jsonMode = true;
  else if (a === '--no-file') noFile = true;
  else if (a === '--out') outFlag = args[++i] ?? '';
  else if (a === '--db') dbFlag = args[++i] ?? '';
  else if (a === '--project') projectFlag = args[++i] ?? '';
  else if (!a.startsWith('--') && !category) category = a;
}

if (!listMode && !category) {
  console.error('usage: tsx server/category-report.ts <分類> [--project id] [--no-file] [--out path] [--json]  |  --list [--project id] [--json]');
  process.exit(1);
}

const resolved = resolveProject(ROOT, { project: projectFlag || undefined, dbPath: dbFlag || undefined });
const dbPath = dbFlag ? resolve(ROOT, dbFlag) : resolved.dbPath;
if (!dbPath || !existsSync(dbPath)) {
  console.error('no database found; run the Figma extraction first');
  process.exit(1);
}

const v2Path = resolved.labelsPath;
const v2Doc = tryLoadScreenLabelsV2(v2Path);
if (!v2Doc || v2Doc.screens.length === 0) {
  if (jsonMode) {
    console.log(JSON.stringify({ db: dbPath, total: 0, majors: [], note: 'no v2 labels yet' }, null, 2));
    process.exit(listMode ? 0 : 1);
  }
  console.error('no v2 labels yet; run `npm run review:board -- --unlabeled` to inspect AST-grouped screens');
  process.exit(1);
}
const labels = v2Doc.screens;

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const page = new Map<string, string>();
const loadPages = (ids: string[]): void => {
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = db.prepare('SELECT id, page_name FROM nodes WHERE id IN (' + part.map(() => '?').join(',') + ')').all(...part) as Array<{ id: string; page_name: string }>;
    for (const r of rows) page.set(r.id, (r.page_name ?? '').trim());
  }
};

if (listMode) {
  loadPages(labels.map((r) => r.id));
  db.close();
  const data = summarizeCategoriesV2(labels, page);
  if (jsonMode) {
    console.log(JSON.stringify({ db: dbPath, total: labels.length, majors: data }, null, 2));
  } else {
    console.log('# 分類清單（' + resolved.labelsRelPath + '）');
    console.log('');
    console.log('- 畫面總數：' + labels.length);
    console.log('- 大類：' + data.length);
    console.log('');
    console.log('| 大類 | 畫面數 | 小類數 |');
    console.log('|---|---:|---:|');
    for (const rec of data) console.log('| ' + rec.major + ' | ' + rec.count + ' | ' + rec.minors.length + ' |');
    for (const rec of data) {
      console.log('');
      console.log('## ' + rec.major + '（' + rec.count + '）');
      console.log('');
      console.log('| 小類 | 畫面數 | 頁面數 |');
      console.log('|---|---:|---:|');
      for (const sub of rec.minors) {
        console.log('| ' + sub.minor + ' | ' + sub.count + ' | ' + sub.pages + ' |');
      }
    }
  }
  process.exit(0);
}

const wantedIds = labels
  .filter((r) => r.label === category || r.minor === category || r.major === category)
  .map((r) => r.id);
loadPages(wantedIds);
db.close();

const report = categoryReportV2(labels, category, page);
if (!report) {
  console.error('no screens for category: ' + category);
  process.exit(1);
}

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const lines: string[] = [];
lines.push('# ' + report.category + ' · 基準統計');
lines.push('');
lines.push('- 畫面 ID 總數：' + report.total);
lines.push('- 出現頁面：' + report.pages.length);
lines.push('');
for (const pg of report.pages) {
  lines.push('## ' + pg.page + '（' + pg.count + '）');
  lines.push('');
  for (const id of pg.ids) lines.push(id);
  lines.push('');
}
const text = lines.join('\n') + '\n';
console.log(text);

if (!noFile) {
  const safeCategoryName = category.replace(/[\\/:*?"<>|]/g, '-');
  const out = outFlag ? resolve(ROOT, outFlag) : join(ROOT, '.scratch', 'rea-figma-category-' + safeCategoryName + '.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, 'utf8');
  console.log('written ' + out);
}
