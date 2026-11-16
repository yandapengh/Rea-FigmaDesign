/// <reference lib="es2022" />
/**
 * Read-only audit of a Rea-FigmaDesign SQLite graph.
 *
 * Usage:
 *   npx tsx server/audit-db.ts ./data/rea-figma.sqlite
 *   npx tsx server/audit-db.ts ./data/rea-figma.sqlite --expected-content-pages=65 --empty-pages=12
 *   npx tsx server/audit-db.ts ./data/rea-figma.sqlite --quick-check
 *
 * This tool never writes to the database. It is safe to run while the
 * ingestion server is idle.
 */

import Database = require('better-sqlite3');
import { existsSync, statSync } from 'node:fs';

interface MetaRow {
  file_key: string;
  file_name: string;
  extracted_at: string;
  page_count: number;
  total_nodes: number;
}

interface PageStat {
  page_id: string;
  page_name: string;
  nodes: number;
  frames: number;
  instances: number;
  texts: number;
  icons: number;
  max_depth: number;
  payload_bytes: number;
}

interface TypeStat {
  type: string;
  n: number;
}

interface QualityRow {
  rows: number;
  bbox_null: number;
  layout_none: number;
  layout_json_bad: number;
  style_json_bad: number;
  bound_json_bad: number;
  with_bound_vars: number;
  with_text: number;
  empty_text: number;
  with_text_style: number;
  with_reactions: number;
  icons: number;
  with_main_component: number;
}

interface ColumnBytes {
  style_bytes: number;
  layout_bytes: number;
  bound_bytes: number;
  text_bytes: number;
  text_style_bytes: number;
  reactions_bytes: number;
}

const argv = process.argv.slice(2);
let dbPath = './data/rea-figma.sqlite';
let expectedContentPages: number | null = null;
let emptyPages: number | null = null;
let quickCheck = false;

for (const arg of argv) {
  if (arg === '--quick-check') {
    quickCheck = true;
    continue;
  }
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const raw = eq === -1 ? '' : arg.slice(eq + 1);
    const value = Number(raw);
    if (key === 'expected-content-pages' && Number.isFinite(value)) expectedContentPages = value;
    if (key === 'empty-pages' && Number.isFinite(value)) emptyPages = value;
    continue;
  }
  dbPath = arg;
}

if (!existsSync(dbPath)) {
  console.error('Database not found: ' + dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function fmt(value: number): string {
  return value.toLocaleString('en-US');
}

function bytes(value: number): string {
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

const meta = db
  .prepare('SELECT file_key, file_name, extracted_at, page_count, total_nodes FROM file_meta LIMIT 1')
  .get() as MetaRow | undefined;

const totals = db
  .prepare(
    'SELECT COUNT(*) AS nodes, COUNT(DISTINCT page_id) AS pages, COUNT(DISTINCT page_name) AS page_names, COALESCE(SUM(parent_id IS NULL), 0) AS roots FROM nodes',
  )
  .get() as { nodes: number; pages: number; page_names: number; roots: number };

const pageStats = db
  .prepare(
    "SELECT page_id, page_name, COUNT(*) AS nodes, " +
      "COALESCE(SUM(type = 'FRAME'), 0) AS frames, " +
      "COALESCE(SUM(type = 'INSTANCE'), 0) AS instances, " +
      "COALESCE(SUM(type = 'TEXT'), 0) AS texts, " +
      "COALESCE(SUM(is_icon_container = 1), 0) AS icons, " +
      "COALESCE(MAX(depth), 0) AS max_depth, " +
      "COALESCE(SUM(length(CAST(style_json AS BLOB)) + length(CAST(layout_props_json AS BLOB)) + " +
      "length(CAST(bound_variables_json AS BLOB)) + COALESCE(length(CAST(text_content AS BLOB)), 0) + " +
      "COALESCE(length(CAST(text_style_json AS BLOB)), 0) + COALESCE(length(CAST(reactions_json AS BLOB)), 0)), 0) AS payload_bytes " +
      'FROM nodes GROUP BY page_id, page_name ORDER BY nodes DESC',
  )
  .all() as PageStat[];

const typeStats = db
  .prepare('SELECT type, COUNT(*) AS n FROM nodes GROUP BY type ORDER BY n DESC')
  .all() as TypeStat[];

const quality = db
  .prepare(
    'SELECT COUNT(*) AS rows, ' +
      'COALESCE(SUM(bbox_x IS NULL), 0) AS bbox_null, ' +
      "COALESCE(SUM(layout_mode = 'NONE'), 0) AS layout_none, " +
      'COALESCE(SUM(json_valid(layout_props_json) = 0), 0) AS layout_json_bad, ' +
      'COALESCE(SUM(json_valid(style_json) = 0), 0) AS style_json_bad, ' +
      'COALESCE(SUM(json_valid(bound_variables_json) = 0), 0) AS bound_json_bad, ' +
      "COALESCE(SUM(bound_variables_json <> '{}'), 0) AS with_bound_vars, " +
      'COALESCE(SUM(text_content IS NOT NULL), 0) AS with_text, ' +
      "COALESCE(SUM(text_content IS NOT NULL AND length(text_content) = 0), 0) AS empty_text, " +
      'COALESCE(SUM(text_style_json IS NOT NULL), 0) AS with_text_style, ' +
      'COALESCE(SUM(reactions_json IS NOT NULL), 0) AS with_reactions, ' +
      'COALESCE(SUM(is_icon_container = 1), 0) AS icons, ' +
      'COALESCE(SUM(main_component_id IS NOT NULL), 0) AS with_main_component ' +
      'FROM nodes',
  )
  .get() as QualityRow;

const orphans = db
  .prepare(
    'SELECT COUNT(*) AS n FROM nodes n LEFT JOIN nodes p ON n.parent_id = p.id WHERE n.parent_id IS NOT NULL AND p.id IS NULL',
  )
  .get() as { n: number };

const rootlessPages = db
  .prepare(
    'SELECT page_id, page_name, COUNT(*) AS nodes, COALESCE(SUM(parent_id IS NULL), 0) AS roots ' +
      'FROM nodes GROUP BY page_id, page_name HAVING roots = 0',
  )
  .all() as { page_id: string; page_name: string; nodes: number; roots: number }[];

const columnBytes = db
  .prepare(
    'SELECT ' +
      'COALESCE(SUM(length(CAST(style_json AS BLOB))), 0) AS style_bytes, ' +
      'COALESCE(SUM(length(CAST(layout_props_json AS BLOB))), 0) AS layout_bytes, ' +
      'COALESCE(SUM(length(CAST(bound_variables_json AS BLOB))), 0) AS bound_bytes, ' +
      'COALESCE(SUM(length(CAST(text_content AS BLOB))), 0) AS text_bytes, ' +
      'COALESCE(SUM(length(CAST(text_style_json AS BLOB))), 0) AS text_style_bytes, ' +
      'COALESCE(SUM(length(CAST(reactions_json AS BLOB))), 0) AS reactions_bytes ' +
      'FROM nodes',
  )
  .get() as ColumnBytes;

const componentStats = db
  .prepare(
    "SELECT (SELECT COUNT(*) FROM components) AS table_rows, " +
      "(SELECT COUNT(*) FROM nodes WHERE type = 'COMPONENT') AS component_nodes, " +
      "(SELECT COUNT(*) FROM nodes WHERE type = 'COMPONENT_SET') AS set_nodes, " +
      '(SELECT COUNT(*) FROM nodes WHERE main_component_id IS NOT NULL) AS instance_refs',
  )
  .get() as { table_rows: number; component_nodes: number; set_nodes: number; instance_refs: number };

const missingComponentMeta = db
  .prepare(
    'SELECT COUNT(*) AS n FROM nodes n WHERE n.main_component_id IS NOT NULL ' +
      'AND NOT EXISTS (SELECT 1 FROM components c WHERE c.id = n.main_component_id)',
  )
  .get() as { n: number };

const variableStats = db
  .prepare(
    'SELECT COUNT(*) AS variables, ' +
      "COALESCE(SUM(values_by_mode_json LIKE '%VARIABLE_ALIAS%'), 0) AS with_alias, " +
      "COALESCE(SUM(scopes_json = '[]'), 0) AS no_scopes " +
      'FROM variables',
  )
  .get() as { variables: number; with_alias: number; no_scopes: number };

const last = db
  .prepare(
    'SELECT rowid, page_id, page_name, type, name FROM nodes WHERE rowid = (SELECT MAX(rowid) FROM nodes)',
  )
  .get() as { rowid: number; page_id: string; page_name: string; type: string; name: string } | undefined;

const dbBytes = statSync(dbPath).size;
let walBytes = 0;
try {
  walBytes = statSync(dbPath + '-wal').size;
} catch {
  walBytes = 0;
}

const pageCount = meta ? meta.page_count : 0;
const pagesWithRows = pageStats.length;
const pagesWithoutRows = Math.max(0, pageCount - pagesWithRows);
const incomplete = !meta || meta.total_nodes === 0;
const missingContentPages =
  expectedContentPages !== null ? Math.max(0, expectedContentPages - pagesWithRows) : null;
const unseenNonEmptyPages =
  emptyPages !== null ? Math.max(0, pagesWithoutRows - emptyPages) : null;

console.log('');
console.log('=== Rea-FigmaDesign DB audit ===');
console.log('path'.padEnd(24) + dbPath);
console.log('size'.padEnd(24) + bytes(dbBytes) + ' (WAL ' + bytes(walBytes) + ')');
if (meta) {
  console.log('file'.padEnd(24) + meta.file_name + '  (' + meta.file_key + ')');
  console.log('extracted_at'.padEnd(24) + meta.extracted_at);
  console.log('page_count'.padEnd(24) + fmt(meta.page_count));
} else {
  console.log('file_meta'.padEnd(24) + 'MISSING');
}
console.log('journal_mode'.padEnd(24) + String(db.pragma('journal_mode', { simple: true })));
if (quickCheck) {
  console.log('quick_check'.padEnd(24) + String(db.pragma('quick_check', { simple: true })));
}
console.log('');

console.log('--- completion ---');
console.log('SYNC_COMPLETE'.padEnd(24) + (incomplete ? 'NO (total_nodes = 0)' : 'YES or marker present'));
console.log('nodes'.padEnd(24) + fmt(totals.nodes));
console.log('content pages with rows'.padEnd(24) + fmt(pagesWithRows));
console.log('pages without rows'.padEnd(24) + fmt(pagesWithoutRows));
if (missingContentPages !== null) {
  console.log('missing content pages'.padEnd(24) + fmt(missingContentPages) + ' (assuming ' + expectedContentPages + ' content pages)');
}
if (unseenNonEmptyPages !== null) {
  console.log('unseen non-empty pages'.padEnd(24) + fmt(unseenNonEmptyPages) + ' (assuming ' + emptyPages + ' empty pages)');
}
if (incomplete) {
  console.log('verdict'.padEnd(24) + 'INCOMPLETE — do not trust as a full-file snapshot');
}
console.log('');

console.log('--- data quality (present slice) ---');
console.log('nodes'.padEnd(24) + fmt(quality.rows));
console.log('roots'.padEnd(24) + fmt(totals.roots));
console.log('bbox NULL'.padEnd(24) + fmt(quality.bbox_null));
console.log('layout_mode = NONE'.padEnd(24) + fmt(quality.layout_none));
console.log('bad JSON (layout/style/bound)'.padEnd(24) + fmt(quality.layout_json_bad) + ' / ' + fmt(quality.style_json_bad) + ' / ' + fmt(quality.bound_json_bad));
console.log('orphan parent_id'.padEnd(24) + fmt(orphans.n));
console.log('pages without root'.padEnd(24) + fmt(rootlessPages.length));
console.log('bound variables'.padEnd(24) + fmt(quality.with_bound_vars));
console.log('text nodes'.padEnd(24) + fmt(quality.with_text) + ' (empty ' + fmt(quality.empty_text) + ')');
console.log('text styles'.padEnd(24) + fmt(quality.with_text_style));
console.log('reactions'.padEnd(24) + fmt(quality.with_reactions));
console.log('icon containers'.padEnd(24) + fmt(quality.icons));
console.log('main_component_id'.padEnd(24) + fmt(quality.with_main_component));
console.log('');

console.log('--- components / variables ---');
console.log('components table'.padEnd(24) + fmt(componentStats.table_rows));
console.log('COMPONENT nodes'.padEnd(24) + fmt(componentStats.component_nodes));
console.log('COMPONENT_SET nodes'.padEnd(24) + fmt(componentStats.set_nodes));
console.log('component nodes not in table'.padEnd(24) + fmt(Math.max(0, componentStats.component_nodes + componentStats.set_nodes - componentStats.table_rows)) + ' (buffered or partial)');
console.log('instances with main id'.padEnd(24) + fmt(componentStats.instance_refs));
console.log('main ids not in components'.padEnd(24) + fmt(missingComponentMeta.n) + ' (expected while incomplete)');
console.log('variables'.padEnd(24) + fmt(variableStats.variables) + ' (aliases ' + fmt(variableStats.with_alias) + ')');
console.log('variables without scopes'.padEnd(24) + fmt(variableStats.no_scopes));
console.log('');

console.log('--- payload bytes by column ---');
console.log('style_json'.padEnd(24) + bytes(columnBytes.style_bytes));
console.log('layout_props_json'.padEnd(24) + bytes(columnBytes.layout_bytes));
console.log('bound_variables_json'.padEnd(24) + bytes(columnBytes.bound_bytes));
console.log('text_content'.padEnd(24) + bytes(columnBytes.text_bytes));
console.log('text_style_json'.padEnd(24) + bytes(columnBytes.text_style_bytes));
console.log('reactions_json'.padEnd(24) + bytes(columnBytes.reactions_bytes));
const payloadTotal =
  columnBytes.style_bytes +
  columnBytes.layout_bytes +
  columnBytes.bound_bytes +
  columnBytes.text_bytes +
  columnBytes.text_style_bytes +
  columnBytes.reactions_bytes;
console.log('payload total'.padEnd(24) + bytes(payloadTotal));
console.log('DB / payload ratio'.padEnd(24) + (payloadTotal > 0 ? (dbBytes / payloadTotal).toFixed(2) + 'x' : 'n/a'));
console.log('');

if (last) {
  const lastPageStat = pageStats.find((page) => page.page_id === last.page_id);
  console.log('--- last row ---');
  console.log('rowid'.padEnd(24) + fmt(last.rowid));
  console.log('page'.padEnd(24) + last.page_name);
  console.log('node'.padEnd(24) + last.type + ' / ' + last.name);
  console.log('last page nodes'.padEnd(24) + fmt(lastPageStat ? lastPageStat.nodes : 0) + ' (likely partial)');
  console.log('');
}

console.log('--- page coverage (by node count) ---');
console.log(
  'page'.padEnd(44) +
    'nodes'.padStart(9) +
    'depth'.padStart(7) +
    'frame'.padStart(8) +
    'inst'.padStart(8) +
    'text'.padStart(8) +
    'icons'.padStart(8) +
    'payload'.padStart(11),
);
for (const page of pageStats) {
  console.log(
    truncate(page.page_name, 43).padEnd(44) +
      fmt(n(page.nodes)).padStart(9) +
      fmt(n(page.max_depth)).padStart(7) +
      fmt(n(page.frames)).padStart(8) +
      fmt(n(page.instances)).padStart(8) +
      fmt(n(page.texts)).padStart(8) +
      fmt(n(page.icons)).padStart(8) +
      bytes(n(page.payload_bytes)).padStart(11),
  );
}
const pagesTable = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pages'")
  .get() as { name: string } | undefined;

if (pagesTable) {
  const census = db
    .prepare(
      'SELECT COUNT(*) AS total, ' +
        'COALESCE(SUM(CASE WHEN is_empty = 1 THEN 1 ELSE 0 END), 0) AS empty, ' +
        'COALESCE(SUM(CASE WHEN is_empty = 0 THEN 1 ELSE 0 END), 0) AS content ' +
        'FROM pages',
    )
    .get() as { total: number; empty: number; content: number };

  const matched = db
    .prepare(
      'SELECT COUNT(*) AS n FROM pages p WHERE p.is_empty = 0 ' +
        'AND EXISTS (SELECT 1 FROM nodes n WHERE n.page_id = p.page_id)',
    )
    .get() as { n: number };

  const missing = db
    .prepare(
      'SELECT p.page_id, p.page_name, p.child_count FROM pages p WHERE p.is_empty = 0 ' +
        'AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.page_id = p.page_id) ORDER BY p.page_index',
    )
    .all() as { page_id: string; page_name: string; child_count: number }[];

  const extra = db
    .prepare(
      'SELECT DISTINCT n.page_id, n.page_name FROM nodes n ' +
        'WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.page_id = n.page_id) ' +
        'ORDER BY n.page_name',
    )
    .all() as { page_id: string; page_name: string }[];

  console.log('--- page census ---');
  console.log(
    'census pages'.padEnd(24) +
      fmt(census.total) +
      ' (content ' + fmt(census.content) + ' / empty ' + fmt(census.empty) + ')',
  );
  console.log('content pages with nodes'.padEnd(24) + fmt(matched.n) + ' / ' + fmt(census.content));
  console.log('missing content pages'.padEnd(24) + fmt(missing.length));
  if (extra.length > 0) {
    console.log('nodes on pages not in census'.padEnd(24) + fmt(extra.length) + ' (census is stale?)');
  }
  if (missing.length > 0) {
    console.log('missing page list:');
    for (const page of missing) {
      console.log(
        '  ' +
          truncate(page.page_name, 54).padEnd(56) +
          page.page_id +
          '  children=' +
          fmt(page.child_count),
      );
    }
  }
  console.log('');
} else {
  console.log('--- page census ---');
  console.log('pages table'.padEnd(24) + 'missing (run PAGE_CENSUS first)');
  console.log('');
}

console.log('--- node types ---');
for (const type of typeStats) {
  console.log(type.type.padEnd(24) + fmt(type.n));
}
console.log('');

console.log('--- findings ---');
if (incomplete) {
  console.log('- INCOMPLETE: no SYNC_COMPLETE / total_nodes is 0; this is a prefix of the traversal.');
}
if (missingContentPages !== null && missingContentPages > 0) {
  console.log('- Missing content pages: ' + fmt(missingContentPages) + ' of ' + fmt(expectedContentPages || 0) + '.');
}
if (last) {
  console.log('- Last write is on "' + last.page_name + '"; that page must be treated as partial.');
}
if (componentStats.table_rows < componentStats.component_nodes + componentStats.set_nodes) {
  console.log('- components table is behind the node graph; do not use it as a complete catalog yet.');
}
if (quality.layout_json_bad + quality.style_json_bad + quality.bound_json_bad === 0) {
  console.log('- Present rows are structurally clean: all JSON blobs valid, no orphan parent_id, bbox complete.');
}
console.log('- Not stored by design: vectorPaths/vectorNetwork, raw image bytes, resolved alias values, remote/library variables.');
console.log('');

db.close();
