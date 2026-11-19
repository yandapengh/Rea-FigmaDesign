/// <reference lib="es2022" />
/** Stage 1 migration: a v1 (id-only) database must become a v2 (file_key) one without loss. */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database = require('better-sqlite3');
import { AstGraphDB } from './db';

const DB_PATH = join(tmpdir(), 'rea-figma-stage1-migrate-' + process.pid + '.sqlite');
let failures = 0;
function check(name: string, ok: boolean, detail: string = ''): void {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures += 1;
}

function buildV1(): void {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE file_meta (file_key TEXT PRIMARY KEY, file_name TEXT NOT NULL, extracted_at TEXT NOT NULL, page_count INTEGER NOT NULL, total_nodes INTEGER DEFAULT 0);
    CREATE TABLE variables (id TEXT PRIMARY KEY, name TEXT NOT NULL, collection_id TEXT NOT NULL, collection_name TEXT NOT NULL, resolved_type TEXT NOT NULL, values_by_mode_json TEXT NOT NULL, scopes_json TEXT NOT NULL);
    CREATE TABLE components (id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL, component_set_id TEXT, component_set_name TEXT, variant_properties_json TEXT, description TEXT, page_id TEXT NOT NULL, page_name TEXT NOT NULL);
    CREATE TABLE pages (page_id TEXT PRIMARY KEY, page_name TEXT NOT NULL, page_index INTEGER NOT NULL, child_count INTEGER NOT NULL, is_empty INTEGER NOT NULL, census_at TEXT NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, parent_id TEXT, page_id TEXT NOT NULL, page_name TEXT NOT NULL, child_index INTEGER NOT NULL, depth INTEGER NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, visible INTEGER NOT NULL, main_component_id TEXT, is_icon_container INTEGER NOT NULL DEFAULT 0, layout_mode TEXT NOT NULL, layout_props_json TEXT NOT NULL, bbox_x REAL, bbox_y REAL, bbox_w REAL, bbox_h REAL, style_json TEXT NOT NULL, bound_variables_json TEXT NOT NULL, text_content TEXT, text_style_json TEXT, reactions_json TEXT);
  `);
  db.prepare('INSERT INTO file_meta VALUES (?, ?, ?, ?, ?)').run('oldFile', 'Old File', '2026-01-01T00:00:00Z', 1, 2);
  db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?)').run('oldP', 'Old Page', 0, 2, 0, '2026-01-01T00:00:00Z');
  const insert = db.prepare(
    'INSERT INTO nodes (id, parent_id, page_id, page_name, child_index, depth, type, name, visible, main_component_id, is_icon_container, layout_mode, layout_props_json, bbox_x, bbox_y, bbox_w, bbox_h, style_json, bound_variables_json, text_content, text_style_json, reactions_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 2; i += 1) {
    insert.run('old' + i, null, 'oldP', 'Old Page', i, 0, 'FRAME', 'old' + i, 1, null, 0, 'NONE', '{}', 0, 0, 390, 844, '{}', '{}', null, null, null);
  }
  db.close();
}

function main(): void {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  buildV1();
  const db = new AstGraphDB(DB_PATH);
  const pages = db.listPages('oldFile');
  check('migrate: page survives with DONE status', pages.length === 1 && pages[0].status === 'DONE', JSON.stringify(pages));
  check('migrate: node_count backfilled to 2', pages[0]?.node_count === 2);
  const raw = (db as unknown as { db: Database.Database }).db;
  const n = (raw.prepare('SELECT COUNT(*) AS c FROM nodes WHERE file_key = ?').get('oldFile') as { c: number }).c;
  check('migrate: both nodes carry the legacy file_key', n === 2);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);

  console.log('');
  if (failures > 0) {
    console.log('RESULT: FAIL (' + failures + ')');
    process.exit(1);
  }
  console.log('RESULT: OK — v1 database migrates to composite keys without loss');
}

main();
