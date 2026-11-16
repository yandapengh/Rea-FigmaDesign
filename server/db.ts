/// <reference lib="es2022" />
/**
 * AstGraphDB — local SQLite sink for the dehydrated Figma AST.
 *
 * Design notes:
 *  - WAL + NORMAL synchronous keeps 500-row chunk commits fast without risking
 *    corruption of a partially written graph.
 *  - Every chunk is committed inside a better-sqlite3 transaction using
 *    prepared INSERT OR REPLACE statements (no per-row SQL parsing).
 *  - Incoming rows are normalized field-by-field because a JSON round trip
 *    through postMessage/WebSocket drops `undefined` keys; a missing key must
 *    become NULL (or a safe default), never a thrown bind error mid-chunk.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database = require('better-sqlite3');
import type {
  ComponentRow,
  FileMetaPayload,
  NodeRow,
  PageCensusRow,
  VariableRow,
} from '../shared/protocol';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_meta (
  file_key TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  total_nodes INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS variables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  resolved_type TEXT NOT NULL,
  values_by_mode_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  component_set_id TEXT,
  component_set_name TEXT,
  variant_properties_json TEXT,
  description TEXT,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  page_id TEXT PRIMARY KEY,
  page_name TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  child_count INTEGER NOT NULL,
  is_empty INTEGER NOT NULL,
  census_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
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
  reactions_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_page ON nodes(page_id);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_main_comp ON nodes(main_component_id);
CREATE INDEX IF NOT EXISTS idx_variables_name ON variables(name);
CREATE INDEX IF NOT EXISTS idx_pages_content ON pages(is_empty);
`;

const INSERT_VARIABLE_SQL = `
INSERT OR REPLACE INTO variables
  (id, name, collection_id, collection_name, resolved_type, values_by_mode_json, scopes_json)
VALUES
  (@id, @name, @collection_id, @collection_name, @resolved_type, @values_by_mode_json, @scopes_json)
`;

const INSERT_COMPONENT_SQL = `
INSERT OR REPLACE INTO components
  (id, key, name, component_set_id, component_set_name, variant_properties_json, description, page_id, page_name)
VALUES
  (@id, @key, @name, @component_set_id, @component_set_name, @variant_properties_json, @description, @page_id, @page_name)
`;

const INSERT_PAGE_SQL = `
INSERT OR REPLACE INTO pages
  (page_id, page_name, page_index, child_count, is_empty, census_at)
VALUES
  (@page_id, @page_name, @page_index, @child_count, @is_empty, @census_at)
`;

const INSERT_NODE_SQL = `
INSERT OR REPLACE INTO nodes
  (id, parent_id, page_id, page_name, child_index, depth, type, name, visible,
   main_component_id, is_icon_container, layout_mode, layout_props_json,
   bbox_x, bbox_y, bbox_w, bbox_h, style_json, bound_variables_json,
   text_content, text_style_json, reactions_json)
VALUES
  (@id, @parent_id, @page_id, @page_name, @child_index, @depth, @type, @name, @visible,
   @main_component_id, @is_icon_container, @layout_mode, @layout_props_json,
   @bbox_x, @bbox_y, @bbox_w, @bbox_h, @style_json, @bound_variables_json,
   @text_content, @text_style_json, @reactions_json)
`;

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

function toVariableBindings(row: VariableRow): Bindings {
  return {
    id: text(row.id),
    name: text(row.name),
    collection_id: text(row.collection_id),
    collection_name: text(row.collection_name),
    resolved_type: text(row.resolved_type) || 'UNKNOWN',
    values_by_mode_json: text(row.values_by_mode_json) || '{}',
    scopes_json: text(row.scopes_json) || '[]',
  };
}

function toComponentBindings(row: ComponentRow): Bindings {
  return {
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

function toNodeBindings(row: NodeRow): Bindings {
  return {
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

export class AstGraphDB {
  private readonly db: Database.Database;
  private readonly dbPath: string;

  private readonly insertVariableStmt: Database.Statement;
  private readonly insertComponentStmt: Database.Statement;
  private readonly insertNodeStmt: Database.Statement;

  private readonly insertVariablesTxn: (rows: VariableRow[]) => void;
  private readonly insertComponentsTxn: (rows: ComponentRow[]) => void;
  private readonly insertNodesTxn: (rows: NodeRow[]) => void;
  private readonly replacePageCensusTxn: (rows: PageCensusRow[]) => void;
  private readonly resetTxn: (meta: FileMetaPayload) => void;

  constructor(dbPath = './data/rea-figma.sqlite') {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.dbPath = dbPath;
    this.db = new Database(dbPath);

    // Durability/speed trade-off for a rebuildable local cache.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA_SQL);

    this.insertVariableStmt = this.db.prepare(INSERT_VARIABLE_SQL);
    this.insertComponentStmt = this.db.prepare(INSERT_COMPONENT_SQL);
    this.insertNodeStmt = this.db.prepare(INSERT_NODE_SQL);
    const insertPageStmt = this.db.prepare(INSERT_PAGE_SQL);

    this.insertVariablesTxn = this.db.transaction((rows: VariableRow[]) => {
      for (let i = 0; i < rows.length; i += 1) {
        this.insertVariableStmt.run(toVariableBindings(rows[i]));
      }
    });

    this.insertComponentsTxn = this.db.transaction((rows: ComponentRow[]) => {
      for (let i = 0; i < rows.length; i += 1) {
        this.insertComponentStmt.run(toComponentBindings(rows[i]));
      }
    });

    this.insertNodesTxn = this.db.transaction((rows: NodeRow[]) => {
      for (let i = 0; i < rows.length; i += 1) {
        this.insertNodeStmt.run(toNodeBindings(rows[i]));
      }
    });

    this.replacePageCensusTxn = this.db.transaction((rows: PageCensusRow[]) => {
      this.db.prepare('DELETE FROM pages').run();
      const censusAt = new Date().toISOString();
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        insertPageStmt.run({
          page_id: text(row.page_id),
          page_name: text(row.page_name),
          page_index: finiteNumber(row.page_index, 0),
          child_count: finiteNumber(row.child_count, 0),
          is_empty: row.is_empty === 1 ? 1 : 0,
          census_at: censusAt,
        });
      }
    });

    this.resetTxn = this.db.transaction((meta: FileMetaPayload) => {
      this.db.prepare('DELETE FROM variables').run();
      this.db.prepare('DELETE FROM components').run();
      this.db.prepare('DELETE FROM nodes').run();
      this.db.prepare('DELETE FROM file_meta').run();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO file_meta
             (file_key, file_name, extracted_at, page_count, total_nodes)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .run(
          text(meta.file_key) || 'unknown',
          text(meta.file_name) || 'Untitled',
          text(meta.extracted_at) || new Date().toISOString(),
          finiteNumber(meta.page_count, 0),
        );
    });
  }

  /** Clears the previous graph and pins the new file metadata atomically. */
  resetAndInitFile(meta: FileMetaPayload): void {
    this.resetTxn(meta);
  }

  insertVariablesBatch(rows: VariableRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    this.insertVariablesTxn(rows);
    return rows.length;
  }

  insertComponentsBatch(rows: ComponentRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    this.insertComponentsTxn(rows);
    return rows.length;
  }

  insertNodesBatch(rows: NodeRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    this.insertNodesTxn(rows);
    return rows.length;
  }

  /** Replaces the page census only; nodes/file_meta are untouched. */
  replacePageCensus(rows: PageCensusRow[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    this.replacePageCensusTxn(rows);
    return rows.length;
  }

  /** Stamps the final node count onto the file_meta row. Returns rows updated. */
  finalizeSync(totalNodes: number): number {
    const info = this.db
      .prepare('UPDATE file_meta SET total_nodes = ?')
      .run(finiteNumber(totalNodes, 0));
    return info.changes;
  }

  getStats(): AstGraphStats {
    const file = this.db
      .prepare(
        `SELECT file_key, file_name, extracted_at, page_count, total_nodes
           FROM file_meta LIMIT 1`,
      )
      .get() as FileMetaRow | undefined;

    const count = (table: 'variables' | 'components' | 'nodes'): number => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
        .get() as { c: number };
      return row.c;
    };

    return {
      db_path: this.dbPath,
      file: file ?? null,
      variables: count('variables'),
      components: count('components'),
      nodes: count('nodes'),
    };
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
