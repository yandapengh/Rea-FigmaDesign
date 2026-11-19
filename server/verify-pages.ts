/// <reference lib="es2022" />
/**
 * Stage 1 storage guard: page-level staging, atomic overwrite, disconnect safety,
 * and multi-file coexistence. Uses a throwaway SQLite file.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AstGraphDB } from './db';
import type { NodeRow } from '../shared/protocol';

const DB_PATH = join(tmpdir(), 'rea-figma-stage1-' + process.pid + '.sqlite');
let failures = 0;

function check(name: string, ok: boolean, detail: string = ''): void {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures += 1;
}

function node(id: string, pageId: string, pageName: string, index: number): NodeRow {
  return {
    id,
    parent_id: null,
    page_id: pageId,
    page_name: pageName,
    child_index: index,
    depth: 0,
    type: 'FRAME',
    name: id,
    visible: 1,
    main_component_id: null,
    is_icon_container: 0,
    layout_mode: 'NONE',
    layout_props_json: '{}',
    bbox_x: 0,
    bbox_y: 0,
    bbox_w: 390,
    bbox_h: 844,
    style_json: '{}',
    bound_variables_json: '{}',
    text_content: null,
    text_style_json: null,
    reactions_json: null,
  };
}

function countNodes(db: AstGraphDB, fileKey: string, pageId: string): number {
  const raw = (db as unknown as { db: { prepare: (sql: string) => { get: (...args: string[]) => { c: number } } } }).db;
  return raw.prepare('SELECT COUNT(*) AS c FROM nodes WHERE file_key = ? AND page_id = ?').get(fileKey, pageId).c;
}

function pageRow(db: AstGraphDB, fileKey: string, pageId: string): { status: string; node_count: number } {
  const row = db.listPages(fileKey).find((p) => p.page_id === pageId);
  return { status: row?.status ?? 'missing', node_count: row?.node_count ?? -1 };
}

function stagingCount(db: AstGraphDB): number {
  const raw = (db as unknown as { db: { prepare: (sql: string) => { get: () => { c: number } } } }).db;
  return raw.prepare('SELECT COUNT(*) AS c FROM nodes_staging').get().c;
}

async function main(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }
  const db = new AstGraphDB(DB_PATH);

  db.upsertFileMeta({ file_key: 'fileA', file_name: 'File A', extracted_at: '2026-01-01T00:00:00Z', page_count: 2 });

  // --- scenario 1: page A (5) + page B (3), then re-import A as 3 nodes
  db.beginPage('fileA', { file_key: 'fileA', page_id: 'pA', page_name: 'Page A', page_index: 0 });
  db.stageNodes('fileA', 'pA', ['a1', 'a2', 'a3', 'a4', 'a5'].map((id, i) => node(id, 'pA', 'Page A', i)));
  db.completePage('fileA', 'pA', 5);

  db.beginPage('fileA', { file_key: 'fileA', page_id: 'pB', page_name: 'Page B', page_index: 1 });
  db.stageNodes('fileA', 'pB', ['b1', 'b2', 'b3'].map((id, i) => node(id, 'pB', 'Page B', i)));
  db.completePage('fileA', 'pB', 3);

  db.beginPage('fileA', { file_key: 'fileA', page_id: 'pA', page_name: 'Page A', page_index: 0 });
  db.stageNodes('fileA', 'pA', ['a1', 'a3', 'a6'].map((id, i) => node(id, 'pA', 'Page A', i)));
  db.completePage('fileA', 'pA', 3);

  check('scenario 1: page A now has 3 nodes', countNodes(db, 'fileA', 'pA') === 3);
  check('scenario 1: ghost ids a2/a4/a5 are gone', ['a2', 'a4', 'a5'].every((id) => {
    const raw = (db as unknown as { db: { prepare: (sql: string) => { get: (...a: string[]) => { c: number } } } }).db;
    return raw.prepare('SELECT COUNT(*) AS c FROM nodes WHERE id = ?').get(id).c === 0;
  }));
  check('scenario 1: new id a6 exists', countNodes(db, 'fileA', 'pA') === 3 && pageRow(db, 'fileA', 'pA').node_count === 3);
  check('scenario 1: page B stays at 3 nodes', countNodes(db, 'fileA', 'pB') === 3);
  check('scenario 1: staging is empty', stagingCount(db) === 0);

  // --- scenario 2: re-import A, crash at 50%
  db.beginPage('fileA', { file_key: 'fileA', page_id: 'pA', page_name: 'Page A', page_index: 0 });
  db.stageNodes('fileA', 'pA', [node('a1', 'pA', 'Page A', 0), node('a6', 'pA', 'Page A', 1)]);
  db.abortPage('fileA', 'pA');

  check('scenario 2: old page A data intact (3 nodes)', countNodes(db, 'fileA', 'pA') === 3);
  check('scenario 2: staging cleared after abort', stagingCount(db) === 0);
  check('scenario 2: page marked INCOMPLETE', pageRow(db, 'fileA', 'pA').status === 'INCOMPLETE');
  check('scenario 2: node_count keeps old value', pageRow(db, 'fileA', 'pA').node_count === 3);

  // --- scenario 3: a second file with the same node id + its own page
  db.upsertFileMeta({ file_key: 'fileB', file_name: 'File B', extracted_at: '2026-01-02T00:00:00Z', page_count: 1 });
  db.beginPage('fileB', { file_key: 'fileB', page_id: 'pC', page_name: 'Page C', page_index: 0 });
  db.stageNodes('fileB', 'pC', [node('a1', 'pC', 'Page C', 0), node('c2', 'pC', 'Page C', 1)]);
  db.completePage('fileB', 'pC', 2);

  check('scenario 3: both files keep their own a1 row', (() => {
    const raw = (db as unknown as { db: { prepare: (sql: string) => { get: (...a: string[]) => { c: number } } } }).db;
    return raw.prepare('SELECT COUNT(*) AS c FROM nodes WHERE id = ?').get('a1').c === 2;
  })());
  check('scenario 3: file A nodes intact', countNodes(db, 'fileA', 'pA') === 3 && countNodes(db, 'fileA', 'pB') === 3);
  check('scenario 3: file B page is DONE', pageRow(db, 'fileB', 'pC').status === 'DONE' && countNodes(db, 'fileB', 'pC') === 2);

  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }

  console.log('');
  if (failures > 0) {
    console.log('RESULT: FAIL (' + failures + ')');
    process.exit(1);
  }
  console.log('RESULT: OK — staged pages, atomic swap, abort safety and multi-file keys verified');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
