/// <reference lib="es2022" />
/**
 * AstGraphDB — local SQLite sink for the dehydrated Figma AST.
 *
 * Durable per-page model (stage 1):
 *  - every page is staged in nodes_staging, then swapped into nodes inside one transaction
 *  - pages carry status (SYNCING / DONE / INCOMPLETE) and node_count
 *  - every row is keyed by (file_key, id) so split Figma files can share one sink
 *  - SYNC_START never deletes data; only RESET_DATABASE(confirm) does
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database = require('better-sqlite3');
import type {
  ComponentRow,
  FileMetaPayload,
  NodeRow,
  PageCensusRow,
  PageSkipPayload,
  PageStartPayload,
  PageStatusRow,
  VariableRow,
} from '../shared/protocol';

const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS file_meta (
  file_key TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  total_nodes INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS variables (
  file_key TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  resolved_type TEXT NOT NULL,
  values_by_mode_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  PRIMARY KEY (file_key, id)
);

CREATE TABLE IF NOT EXISTS components (
  file_key TEXT NOT NULL,
  id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  component_set_id TEXT,
  component_set_name TEXT,
  variant_properties_json TEXT,
  description TEXT,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  PRIMARY KEY (file_key, id)
);

CREATE TABLE IF NOT EXISTS pages (
  file_key TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  child_count INTEGER NOT NULL DEFAULT 0,
  is_empty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'INCOMPLETE',
  node_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,
  census_at TEXT,
  PRIMARY KEY (file_key, page_id)
);

CREATE TABLE IF NOT EXISTS nodes (
  file_key TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  child_index INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  visible INTEGER NOT NULL,
  main_component_id TEXT,
  is_icon_container INTEGER NOT NULL DEFAULT 0,
  layout_mode TEXT NOT NULL,
  layout_props_json TEXT NOT NULL,
  bbox_x REAL,
  bbox_y REAL,
  bbox_w REAL,
  bbox_h REAL,
  style_json TEXT NOT NULL,
  bound_variables_json TEXT NOT NULL,
  text_content TEXT,
  text_style_json TEXT,
  reactions_json TEXT,
  PRIMARY KEY (file_key, id)
);

CREATE TABLE IF NOT EXISTS batches (
  batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  pages_total INTEGER NOT NULL DEFAULT 0,
  pages_done INTEGER NOT NULL DEFAULT 0,
  pages_skipped INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batch_pages (
  batch_id INTEGER NOT NULL,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  status TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, page_id)
);

CREATE TABLE IF NOT EXISTS hidden_screens (
  file_key TEXT NOT NULL,
  id TEXT NOT NULL,
  opacity REAL NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (file_key, id)
);

CREATE TABLE IF NOT EXISTS nodes_staging (
  file_key TEXT NOT NULL,
  page_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  page_name TEXT NOT NULL,
  child_index INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  visible INTEGER NOT NULL,
  main_component_id TEXT,
  is_icon_container INTEGER NOT NULL DEFAULT 0,
  layout_mode TEXT NOT NULL,
  layout_props_json TEXT NOT NULL,
  bbox_x REAL,
  bbox_y REAL,
  bbox_w REAL,
  bbox_h REAL,
  style_json TEXT NOT NULL,
  bound_variables_json TEXT NOT NULL,
  text_content TEXT,
  text_style_json TEXT,
  reactions_json TEXT,
  PRIMARY KEY (file_key, page_id, id)
);
`;

const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(file_key, parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_page ON nodes(file_key, page_id);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(file_key, type);
CREATE INDEX IF NOT EXISTS idx_nodes_main_comp ON nodes(file_key, main_component_id);
CREATE INDEX IF NOT EXISTS idx_variables_name ON variables(file_key, name);
CREATE INDEX IF NOT EXISTS idx_pages_content ON pages(file_key, is_empty);
CREATE INDEX IF NOT EXISTS idx_staging_page ON nodes_staging(file_key, page_id);
`;

const NODE_COLUMNS =
  'id, parent_id, page_id, page_name, child_index, depth, type, name, visible, ' +
  'main_component_id, is_icon_container, layout_mode, layout_props_json, ' +
  'bbox_x, bbox_y, bbox_w, bbox_h, style_json, bound_variables_json, ' +
  'text_content, text_style_json, reactions_json';

const INSERT_NODE_SQL =
  'INSERT OR REPLACE INTO nodes (file_key, ' + NODE_COLUMNS + ') VALUES (' +
  '@file_key, @id, @parent_id, @page_id, @page_name, @child_index, @depth, @type, @name, @visible, ' +
  '@main_component_id, @is_icon_container, @layout_mode, @layout_props_json, ' +
  '@bbox_x, @bbox_y, @bbox_w, @bbox_h, @style_json, @bound_variables_json, ' +
  '@text_content, @text_style_json, @reactions_json)';

const STAGING_COLUMNS =
  'id, parent_id, page_name, child_index, depth, type, name, visible, ' +
  'main_component_id, is_icon_container, layout_mode, layout_props_json, ' +
  'bbox_x, bbox_y, bbox_w, bbox_h, style_json, bound_variables_json, ' +
  'text_content, text_style_json, reactions_json';

const INSERT_STAGING_SQL =
  'INSERT OR REPLACE INTO nodes_staging (file_key, page_id, ' + STAGING_COLUMNS + ') VALUES (' +
  '@file_key, @page_id, @id, @parent_id, @page_name, @child_index, @depth, @type, @name, @visible, ' +
  '@main_component_id, @is_icon_container, @layout_mode, @layout_props_json, ' +
  '@bbox_x, @bbox_y, @bbox_w, @bbox_h, @style_json, @bound_variables_json, ' +
  '@text_content, @text_style_json, @reactions_json)';

const INSERT_VARIABLE_SQL =
  'INSERT OR REPLACE INTO variables (file_key, id, name, collection_id, collection_name, resolved_type, values_by_mode_json, scopes_json) ' +
  'VALUES (@file_key, @id, @name, @collection_id, @collection_name, @resolved_type, @values_by_mode_json, @scopes_json)';

const INSERT_COMPONENT_SQL =
  'INSERT OR REPLACE INTO components (file_key, id, key, name, component_set_id, component_set_name, variant_properties_json, description, page_id, page_name) ' +
  'VALUES (@file_key, @id, @key, @name, @component_set_id, @component_set_name, @variant_properties_json, @description, @page_id, @page_name)';

const UPSERT_FILE_SQL =
  'INSERT INTO file_meta (file_key, file_name, extracted_at, page_count, total_nodes, updated_at) ' +
  'VALUES (@file_key, @file_name, @extracted_at, @page_count, 0, @updated_at) ' +
  'ON CONFLICT(file_key) DO UPDATE SET file_name = excluded.file_name, extracted_at = excluded.extracted_at, page_count = excluded.page_count, updated_at = excluded.updated_at';

export interface FileMetaRow {
  file_key: string;
  file_name: string;
  extracted_at: string;
  page_count: number;
  total_nodes: number;
}

export interface AstGraphStats {
  db_path: string;
  file: FileMetaRow | null;
  variables: number;
  components: number;
  nodes: number;
}

type Bindings = Record<string, string | number | null>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toVariableBindings(fileKey: string, row: VariableRow): Bindings {
  return {
    file_key: fileKey,
    id: text(row.id),
    name: text(row.name),
    collection_id: text(row.collection_id),
    collection_name: text(row.collection_name),
    resolved_type: text(row.resolved_type) || 'UNKNOWN',
    values_by_mode_json: text(row.values_by_mode_json) || '{}',
    scopes_json: text(row.scopes_json) || '[]',
  };
}

function toComponentBindings(fileKey: string, row: ComponentRow): Bindings {
  return {
    file_key: fileKey,
    id: text(row.id),
    key: text(row.key),
    name: text(row.name),
    component_set_id: nullableText(row.component_set_id),
    component_set_name: nullableText(row.component_set_name),
    variant_properties_json: nullableText(row.variant_properties_json),
    description: nullableText(row.description),
    page_id: text(row.page_id),
    page_name: text(row.page_name),
  };
}

function toNodeBindings(fileKey: string, row: NodeRow): Bindings {
  return {
    file_key: fileKey,
    id: text(row.id),
    parent_id: nullableText(row.parent_id),
    page_id: text(row.page_id),
    page_name: text(row.page_name),
    child_index: finiteNumber(row.child_index, 0),
    depth: finiteNumber(row.depth, 0),
    type: text(row.type) || 'UNKNOWN',
    name: text(row.name),
    visible: row.visible === 0 ? 0 : 1,
    main_component_id: nullableText(row.main_component_id),
    is_icon_container: row.is_icon_container === 1 ? 1 : 0,
    layout_mode: text(row.layout_mode) || 'NONE',
    layout_props_json: text(row.layout_props_json) || '{}',
    bbox_x: nullableNumber(row.bbox_x),
    bbox_y: nullableNumber(row.bbox_y),
    bbox_w: nullableNumber(row.bbox_w),
    bbox_h: nullableNumber(row.bbox_h),
    style_json: text(row.style_json) || '{}',
    bound_variables_json: text(row.bound_variables_json) || '{}',
    text_content: nullableText(row.text_content),
    text_style_json: nullableText(row.text_style_json),
    reactions_json: nullableText(row.reactions_json),
  };
}

function tableColumns(db: Database.Database, table: string): string[] {
  try {
    return (db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return [];
  }
}

export class AstGraphDB {
  private readonly db: Database.Database;
  private readonly dbPath: string;

  private readonly insertVariableStmt: Database.Statement;
  private readonly insertComponentStmt: Database.Statement;
  private readonly insertNodeStmt: Database.Statement;
  private readonly insertStagingStmt: Database.Statement;

  constructor(dbPath = './data/rea-figma.sqlite') {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrateIfNeeded();
    this.db.exec(SCHEMA_TABLES);
    this.db.exec(INDEX_SQL);
    this.db.pragma('user_version = 2');

    this.insertVariableStmt = this.db.prepare(INSERT_VARIABLE_SQL);
    this.insertComponentStmt = this.db.prepare(INSERT_COMPONENT_SQL);
    this.insertNodeStmt = this.db.prepare(INSERT_NODE_SQL);
    this.insertStagingStmt = this.db.prepare(INSERT_STAGING_SQL);
  }

  /** v1 (single-file, id-only primary keys) -> v2 (file_key composite keys). */
  private migrateIfNeeded(): void {
    const cols = tableColumns(this.db, 'nodes');
    if (cols.length === 0 || cols.indexOf('file_key') !== -1) return;

    const legacyMeta = this.db.prepare('SELECT file_key, file_name, extracted_at, page_count, total_nodes FROM file_meta LIMIT 1').get() as
      | { file_key: string; file_name: string; extracted_at: string; page_count: number; total_nodes: number }
      | undefined;
    const fileKey = legacyMeta?.file_key || 'legacy';

    this.db.transaction(() => {
      for (const idx of ['idx_nodes_parent', 'idx_nodes_page', 'idx_nodes_type', 'idx_nodes_main_comp', 'idx_variables_name', 'idx_pages_content']) {
        this.db.exec('DROP INDEX IF EXISTS ' + idx);
      }
      this.db.exec('ALTER TABLE nodes RENAME TO nodes_v1');
      this.db.exec('ALTER TABLE pages RENAME TO pages_v1');
      this.db.exec('ALTER TABLE components RENAME TO components_v1');
      this.db.exec('ALTER TABLE variables RENAME TO variables_v1');
      this.db.exec('ALTER TABLE file_meta RENAME TO file_meta_v1');
      this.db.exec(SCHEMA_TABLES);
      this.db.prepare('INSERT OR REPLACE INTO nodes (file_key, ' + NODE_COLUMNS + ') SELECT ?, ' + NODE_COLUMNS + ' FROM nodes_v1').run(fileKey);
      this.db
        .prepare(
          'INSERT OR REPLACE INTO pages (file_key, page_id, page_name, page_index, child_count, is_empty, status, node_count, synced_at, census_at) ' +
            'SELECT ?, page_id, page_name, page_index, child_count, is_empty, ?, (SELECT COUNT(*) FROM nodes_v1 n WHERE n.page_id = pages_v1.page_id), census_at, census_at FROM pages_v1',
        )
        .run(fileKey, 'DONE');
      this.db
        .prepare(
          'INSERT OR REPLACE INTO components (file_key, id, key, name, component_set_id, component_set_name, variant_properties_json, description, page_id, page_name) ' +
            'SELECT ?, id, key, name, component_set_id, component_set_name, variant_properties_json, description, page_id, page_name FROM components_v1',
        )
        .run(fileKey);
      this.db
        .prepare(
          'INSERT OR REPLACE INTO variables (file_key, id, name, collection_id, collection_name, resolved_type, values_by_mode_json, scopes_json) ' +
            'SELECT ?, id, name, collection_id, collection_name, resolved_type, values_by_mode_json, scopes_json FROM variables_v1',
        )
        .run(fileKey);
      this.db
        .prepare(
          'INSERT OR REPLACE INTO file_meta (file_key, file_name, extracted_at, page_count, total_nodes, updated_at) ' +
            'SELECT file_key, file_name, extracted_at, page_count, total_nodes, extracted_at FROM file_meta_v1',
        )
        .run();
      for (const t of ['nodes_v1', 'pages_v1', 'components_v1', 'variables_v1', 'file_meta_v1']) {
        this.db.exec('DROP TABLE ' + t);
      }
    })();
  }

  upsertFileMeta(meta: FileMetaPayload): void {
    this.db.prepare(UPSERT_FILE_SQL).run({
      file_key: text(meta.file_key) || 'unknown',
      file_name: text(meta.file_name) || 'Untitled',
      extracted_at: text(meta.extracted_at) || new Date().toISOString(),
      page_count: finiteNumber(meta.page_count, 0),
      updated_at: new Date().toISOString(),
    });
  }

  beginPage(fileKey: string, page: PageStartPayload): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM nodes_staging WHERE file_key = ? AND page_id = ?').run(fileKey, page.page_id);
      this.db
        .prepare(
          'INSERT INTO pages (file_key, page_id, page_name, page_index, child_count, is_empty, status, node_count, synced_at, census_at) ' +
            'VALUES (@file_key, @page_id, @page_name, @page_index, @child_count, @is_empty, @status, 0, NULL, @census_at) ' +
            'ON CONFLICT(file_key, page_id) DO UPDATE SET page_name = excluded.page_name, page_index = excluded.page_index, status = excluded.status',
        )
        .run({
          file_key: fileKey,
          page_id: page.page_id,
          page_name: text(page.page_name),
          page_index: finiteNumber(page.page_index, 0),
          child_count: finiteNumber(page.child_count, 0),
          is_empty: page.is_empty === 1 ? 1 : 0,
          status: 'SYNCING',
          census_at: now,
        });
    })();
  }

  stageNodes(fileKey: string, pageId: string, rows: NodeRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const txn = this.db.transaction((list: NodeRow[]) => {
      for (const row of list) {
        const bind = toNodeBindings(fileKey, row);
        bind.page_id = pageId;
        this.insertStagingStmt.run(bind);
      }
    });
    txn(rows);
    return rows.length;
  }

  completePage(fileKey: string, pageId: string, expected?: number): number {
    return this.db.transaction(() => {
      const staged = (this.db.prepare('SELECT COUNT(*) AS c FROM nodes_staging WHERE file_key = ? AND page_id = ?').get(fileKey, pageId) as { c: number }).c;
      if (typeof expected === 'number' && expected !== staged) {
        throw new Error('staged count mismatch: expected ' + expected + ', got ' + staged);
      }
      this.db.prepare('DELETE FROM nodes WHERE file_key = ? AND page_id = ?').run(fileKey, pageId);
      this.db
        .prepare('INSERT OR REPLACE INTO nodes (file_key, ' + NODE_COLUMNS + ') SELECT file_key, ' + NODE_COLUMNS + ' FROM nodes_staging WHERE file_key = ? AND page_id = ?')
        .run(fileKey, pageId);
      this.db.prepare('DELETE FROM nodes_staging WHERE file_key = ? AND page_id = ?').run(fileKey, pageId);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE pages SET status = ?, node_count = ?, synced_at = ? WHERE file_key = ? AND page_id = ?').run('DONE', staged, now, fileKey, pageId);
      this.db.prepare('UPDATE file_meta SET total_nodes = (SELECT COUNT(*) FROM nodes WHERE file_key = ?), updated_at = ? WHERE file_key = ?').run(fileKey, now, fileKey);
      return staged;
    })();
  }

  beginBatch(fileKey: string, pages: Array<{ page_id: string; page_name: string }>): number {
    return this.db.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO batches (file_key, started_at, status, pages_total) VALUES (?, ?, ?, ?)')
        .run(fileKey, new Date().toISOString(), 'RUNNING', pages.length);
      const id = Number(info.lastInsertRowid);
      const stmt = this.db.prepare('INSERT INTO batch_pages (batch_id, page_id, page_name, status) VALUES (?, ?, ?, ?)');
      for (const page of pages) stmt.run(id, page.page_id, page.page_name, 'PENDING');
      return id;
    })();
  }

  setBatchPage(batchId: number, pageId: string, pageName: string, status: string, nodeCount: number): void {
    this.db
      .prepare('INSERT INTO batch_pages (batch_id, page_id, page_name, status, node_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(batch_id, page_id) DO UPDATE SET status = excluded.status, node_count = excluded.node_count')
      .run(batchId, pageId, pageName, status, nodeCount);
  }

  finishBatch(batchId: number, status: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE batches SET finished_at = ?, status = ?, pages_done = (SELECT COUNT(*) FROM batch_pages WHERE batch_id = ? AND status = 'DONE'), pages_skipped = (SELECT COUNT(*) FROM batch_pages WHERE batch_id = ? AND status = 'SKIPPED'), pages_failed = (SELECT COUNT(*) FROM batch_pages WHERE batch_id = ? AND status IN ('INCOMPLETE','FAILED')) WHERE batch_id = ?").run(new Date().toISOString(), status, batchId, batchId, batchId, batchId);
    })();
  }

  latestBatch(fileKey: string): Record<string, unknown> | null {
    return (this.db.prepare('SELECT * FROM batches WHERE file_key = ? ORDER BY batch_id DESC LIMIT 1').get(fileKey) as Record<string, unknown> | undefined) ?? null;
  }

  listBatches(fileKey: string, limit: number): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM batches WHERE file_key = ? ORDER BY batch_id DESC LIMIT ?').all(fileKey, limit) as Array<Record<string, unknown>>;
  }

  /** Local files have file_key 0:0 and page ids can change; match by name/index. */
  resolvePageId(fileKey: string, page: { page_id: string; page_name: string; page_index: number }): string {
    const direct = this.db.prepare('SELECT page_id FROM pages WHERE file_key = ? AND page_id = ?').get(fileKey, page.page_id) as { page_id: string } | undefined;
    if (direct) return direct.page_id;
    const sameName = this.db.prepare('SELECT page_id FROM pages WHERE file_key = ? AND page_name = ?').all(fileKey, page.page_name) as Array<{ page_id: string }>;
    if (sameName.length === 1) return sameName[0].page_id;
    const sameSlot = this.db.prepare('SELECT page_id FROM pages WHERE file_key = ? AND page_index = ? AND page_name = ?').get(fileKey, page.page_index, page.page_name) as { page_id: string } | undefined;
    if (sameSlot) return sameSlot.page_id;
    return page.page_id;
  }

  saveHiddenScreens(fileKey: string, rows: Array<{ id: string; opacity: number }>): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const now = new Date().toISOString();
    const stmt = this.db.prepare('INSERT OR REPLACE INTO hidden_screens (file_key, id, opacity, scanned_at) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => { for (const r of rows) stmt.run(fileKey, String(r.id), Number(r.opacity) || 0, now); })();
    return rows.length;
  }

  skipPage(fileKey: string, page: PageSkipPayload): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO pages (file_key, page_id, page_name, page_index, child_count, is_empty, status, node_count, synced_at, census_at) ' +
          'VALUES (@file_key, @page_id, @page_name, @page_index, 0, 1, @status, 0, NULL, @census_at) ' +
          'ON CONFLICT(file_key, page_id) DO UPDATE SET page_name = excluded.page_name, page_index = excluded.page_index, status = excluded.status',
      )
      .run({ file_key: fileKey, page_id: page.page_id, page_name: page.page_name, page_index: page.page_index, status: 'SKIPPED', census_at: now });
  }

  abortPage(fileKey: string, pageId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM nodes_staging WHERE file_key = ? AND page_id = ?').run(fileKey, pageId);
      this.db.prepare('UPDATE pages SET status = ? WHERE file_key = ? AND page_id = ? AND status = ?').run('INCOMPLETE', fileKey, pageId, 'SYNCING');
    })();
  }

  listPages(fileKey?: string): PageStatusRow[] {
    const sql =
      'SELECT file_key, page_id, page_name, page_index, status, node_count, synced_at, child_count, is_empty, census_at FROM pages' +
      (fileKey ? ' WHERE file_key = ?' : '') +
      ' ORDER BY file_key, page_index';
    return (fileKey ? this.db.prepare(sql).all(fileKey) : this.db.prepare(sql).all()) as PageStatusRow[];
  }

  replacePageCensus(fileKey: string, rows: PageCensusRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const now = new Date().toISOString();
    const txn = this.db.transaction((list: PageCensusRow[]) => {
      const stmt = this.db.prepare(
        'INSERT INTO pages (file_key, page_id, page_name, page_index, child_count, is_empty, status, node_count, synced_at, census_at) ' +
          'VALUES (@file_key, @page_id, @page_name, @page_index, @child_count, @is_empty, @status, 0, NULL, @census_at) ' +
          'ON CONFLICT(file_key, page_id) DO UPDATE SET page_name = excluded.page_name, page_index = excluded.page_index, child_count = excluded.child_count, is_empty = excluded.is_empty, census_at = excluded.census_at',
      );
      for (const row of list) {
        stmt.run({
          file_key: fileKey,
          page_id: text(row.page_id),
          page_name: text(row.page_name),
          page_index: finiteNumber(row.page_index, 0),
          child_count: finiteNumber(row.child_count, 0),
          is_empty: row.is_empty === 1 ? 1 : 0,
          status: 'INCOMPLETE',
          census_at: now,
        });
      }
    });
    txn(rows);
    return rows.length;
  }

  insertVariablesBatch(fileKey: string, rows: VariableRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const txn = this.db.transaction((list: VariableRow[]) => {
      for (const row of list) this.insertVariableStmt.run(toVariableBindings(fileKey, row));
    });
    txn(rows);
    return rows.length;
  }

  insertComponentsBatch(fileKey: string, rows: ComponentRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const txn = this.db.transaction((list: ComponentRow[]) => {
      for (const row of list) this.insertComponentStmt.run(toComponentBindings(fileKey, row));
    });
    txn(rows);
    return rows.length;
  }

  /** Legacy path: the old plugin sends no PAGE_START. */
  insertNodesBatch(fileKey: string, rows: NodeRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const txn = this.db.transaction((list: NodeRow[]) => {
      for (const row of list) this.insertNodeStmt.run(toNodeBindings(fileKey, row));
    });
    txn(rows);
    return rows.length;
  }

  finalizeSync(fileKey: string, totalNodes: number): number {
    const info = this.db
      .prepare('UPDATE file_meta SET total_nodes = ?, updated_at = ? WHERE file_key = ?')
      .run(finiteNumber(totalNodes, 0), new Date().toISOString(), fileKey);
    return info.changes;
  }

  resetAll(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM nodes_staging');
      this.db.exec('DELETE FROM pages');
      this.db.exec('DELETE FROM components');
      this.db.exec('DELETE FROM variables');
      this.db.exec('DELETE FROM file_meta');
    })();
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  getStats(fileKey?: string): AstGraphStats {
    const file = (fileKey
      ? this.db.prepare('SELECT file_key, file_name, extracted_at, page_count, total_nodes FROM file_meta WHERE file_key = ? LIMIT 1').get(fileKey)
      : this.db.prepare('SELECT file_key, file_name, extracted_at, page_count, total_nodes FROM file_meta ORDER BY extracted_at DESC LIMIT 1').get()) as FileMetaRow | undefined;
    const count = (table: 'variables' | 'components' | 'nodes'): number => {
      const sql = 'SELECT COUNT(*) AS c FROM ' + table + (fileKey ? ' WHERE file_key = ?' : '');
      const row = (fileKey ? this.db.prepare(sql).get(fileKey) : this.db.prepare(sql).get()) as { c: number };
      return row.c;
    };
    return { db_path: this.dbPath, file: file ?? null, variables: count('variables'), components: count('components'), nodes: count('nodes') };
  }

  close(): void {
    this.db.close();
  }

  static resolveLatestGraphDb(root: string): string | null {
    const dataRoot = join(root, 'data');
    if (!existsSync(dataRoot)) return null;
    let best: string | null = null;
    let bestTime = 0;
    for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(dataRoot, entry.name, 'graph.sqlite');
      if (!existsSync(candidate)) continue;
      const time = statSync(candidate).mtimeMs;
      if (time > bestTime) { bestTime = time; best = candidate; }
    }
    return best;
  }

  static resolveFileKey(dbPath: string): string | null {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const row = db.prepare('SELECT file_key FROM file_meta ORDER BY extracted_at DESC LIMIT 1').get() as { file_key: string } | undefined;
      db.close();
      return row?.file_key ?? null;
    } catch {
      return null;
    }
  }
}
