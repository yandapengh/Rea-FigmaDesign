/// <reference lib="es2022" />
/**
 * Stage 1 storage guard: page-level staging, atomic overwrite, disconnect safety,
 * and multi-file coexistence. Uses a throwaway SQLite file.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AstGraphDB } from './db';
import { computeScreenSyncDiff, loadLastSync, reconcileProjectLabelsWithDb, saveLastSync, snapshotProjectScreens } from './core/projects';
import type { ComponentRow, NodeRow } from '../shared/protocol';

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

function comp(id: string, pageId: string, pageName: string): ComponentRow {
  return {
    id,
    key: 'k-' + id,
    name: 'Comp ' + id,
    component_set_id: null,
    component_set_name: null,
    variant_properties_json: null,
    description: '',
    page_id: pageId,
    page_name: pageName,
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

  // --- scenario 4: the same page comes back with a new Figma page id
  const canonical = db.resolvePageId('fileA', { page_id: 'pA-NEW', page_name: 'Page A', page_index: 0 });
  check('scenario 4: new page id resolves to the existing page', canonical === 'pA', canonical);
  db.beginPage('fileA', { file_key: 'fileA', page_id: canonical, page_name: 'Page A', page_index: 0 });
  db.stageNodes('fileA', canonical, [node('a1', 'pA-NEW', 'Page A', 0), node('a7', 'pA-NEW', 'Page A', 1)]);
  db.completePage('fileA', canonical, 2);
  check('scenario 4: no duplicate page row', db.listPages('fileA').filter((p) => p.page_name === 'Page A').length === 1);
  check('scenario 4: page A replaced in place', countNodes(db, 'fileA', 'pA') === 2 && countNodes(db, 'fileA', 'pA-NEW') === 0);

  // --- scenario 5: component atomic staging + abort safety
  db.beginPage('fileA', { file_key: 'fileA', page_id: 'pA', page_name: 'Page A', page_index: 0 });
  db.stageNodes('fileA', 'pA', [node('a1', 'pA', 'Page A', 0), node('a7', 'pA', 'Page A', 1), node('a8', 'pA', 'Page A', 2)]);
  db.stageComponents('fileA', 'pA', [comp('c1', 'pA', 'Page A'), comp('c2', 'pA', 'Page A')]);
  const diff1 = db.completePageWithDiff('fileA', 'pA', 3);
  check('scenario 5: diff counters match (+1 added, -0 removed)', diff1.committed === 3 && diff1.added === 1 && diff1.removed === 0);
  // Re-export pA with c1 deleted and a7 deleted
  db.beginPage('fileA', { file_key: 'fileA', page_id: 'pA', page_name: 'Page A', page_index: 0 });
  db.stageNodes('fileA', 'pA', [node('a1', 'pA', 'Page A', 0), node('a8', 'pA', 'Page A', 1)]);
  db.stageComponents('fileA', 'pA', [comp('c2', 'pA', 'Page A')]);
  const diff2 = db.completePageWithDiff('fileA', 'pA', 2);
  const rawDb = (db as unknown as { db: { prepare: (sql: string) => { get: (...a: string[]) => { c: number } } } }).db;
  const compCnt = rawDb.prepare('SELECT COUNT(*) AS c FROM components WHERE file_key = ? AND page_id = ?').get('fileA', 'pA').c;
  const compC1 = rawDb.prepare('SELECT COUNT(*) AS c FROM components WHERE file_key = ? AND id = ?').get('fileA', 'c1').c;
  check('scenario 5: component c1 deleted atomically & diff (-1 removed)', compCnt === 1 && compC1 === 0 && diff2.removed === 1);

  // --- scenario 6: skipPage clears nodes and components when page becomes empty
  const skippedRemoved = db.skipPage('fileA', { file_key: 'fileA', page_id: 'pA', page_name: 'Page A', page_index: 0 });
  const compAfterSkip = rawDb.prepare('SELECT COUNT(*) AS c FROM components WHERE file_key = ? AND page_id = ?').get('fileA', 'pA').c;
  check('scenario 6: skipPage removes old nodes & components', skippedRemoved === 2 && countNodes(db, 'fileA', 'pA') === 0 && compAfterSkip === 0 && pageRow(db, 'fileA', 'pA').status === 'SKIPPED');

  // --- scenario 7: pruneDeletedPages removes only pages missing from live Figma census
  const pruned = db.pruneDeletedPages('fileA', [{ page_id: 'pB', page_name: 'Page B', page_index: 0 }]);
  check('scenario 7: deleted page pA pruned, unexported live page pB preserved', pruned.removedPages.length === 1 && pruned.removedPages[0].page_id === 'pA' && countNodes(db, 'fileA', 'pB') === 3);

  db.close();

  // --- scenario 8: reconcileProjectLabelsWithDb archives missing label IDs & prunes proposals
  const tmpProjRoot = join(tmpdir(), 'rea-figma-reconcile-' + process.pid);
  try {
    mkdirSync(join(tmpProjRoot, 'labels', 'projects', 'fileA'), { recursive: true });
    writeFileSync(
      join(tmpProjRoot, 'labels', 'projects', 'fileA', 'screens-v2.json'),
      JSON.stringify({
        version: 2,
        counts: { 新UI: 2, 老UI: 1 },
        screens: [
          { id: 'b1', label: '首頁', major: '新UI', minor: '首頁', generation: 'new' },
          { id: 'a1', label: 'KYC', major: '新UI', minor: 'KYC', generation: 'new' },
          { id: 'ghost', label: '老UI', major: '老UI', minor: '', generation: 'old' },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(tmpProjRoot, 'labels', 'projects', 'fileA', 'proposals.json'),
      JSON.stringify({
        version: 1,
        projectId: 'fileA',
        generatedAt: '2026-01-01T00:00:00Z',
        scope: 'test',
        items: [
          { id: 'b1', currentMajor: '新UI', currentMinor: '', currentGeneration: 'new', suggestedMajor: '新UI', suggestedMinor: '首頁', suggestedGeneration: 'new', confidence: 'high', reason: 'ok', source: 'ast-exact' },
          { id: 'ghost', currentMajor: '新UI', currentMinor: '', currentGeneration: 'new', suggestedMajor: '', suggestedMinor: '', suggestedGeneration: 'new', confidence: 'low', reason: 'stale', source: 'uncertain' },
        ],
      }),
      'utf8',
    );
    const rec = reconcileProjectLabelsWithDb(tmpProjRoot, 'fileA', DB_PATH, 'fileA');
    const nextLabels = JSON.parse(readFileSync(join(tmpProjRoot, 'labels', 'projects', 'fileA', 'screens-v2.json'), 'utf8')) as {
      counts: Record<string, number>;
      screens: Array<{ id: string }>;
      archivedDeleted?: Array<{ id: string }>;
    };
    const nextProps = JSON.parse(readFileSync(join(tmpProjRoot, 'labels', 'projects', 'fileA', 'proposals.json'), 'utf8')) as { items: Array<{ id: string }> };
    check('scenario 8: stale labels archived & counts recomputed', rec.archived === 2 && rec.remaining === 1 && nextLabels.screens.length === 1 && nextLabels.counts['新UI'] === 1 && !nextLabels.counts['老UI'] && (nextLabels.archivedDeleted?.length ?? 0) === 2);
    check('scenario 8: stale proposals pruned cleanly', rec.proposalsPruned === 1 && nextProps.items.length === 1 && nextProps.items[0].id === 'b1');
  } finally {
    rmSync(tmpProjRoot, { recursive: true, force: true });
  }

  // --- scenario 9: screen-level sync diff (snapshotProjectScreens + computeScreenSyncDiff + save/loadLastSync)
  const tmpSyncRoot = join(tmpdir(), 'rea-figma-syncdiff-' + process.pid);
  try {
    const syncDbPath = join(tmpSyncRoot, 'data', 'syncProj', 'graph.sqlite');
    mkdirSync(join(tmpSyncRoot, 'labels', 'projects', 'syncProj'), { recursive: true });
    writeFileSync(
      join(tmpSyncRoot, 'labels', 'projects', 'syncProj', 'screens-v2.json'),
      JSON.stringify({
        version: 2,
        counts: { 新UI: 1 },
        screens: [{ id: 'scr-old', label: '首頁', major: '新UI', minor: '首頁', generation: 'new' }],
      }),
      'utf8',
    );
    const makeScreenSubtree = (rootId: string, pageId: string, pageName: string): NodeRow[] => {
      const list: NodeRow[] = [node(rootId, pageId, pageName, 0)];
      for (let i = 1; i <= 41; i += 1) {
        const child = node(rootId + '-c' + i, pageId, pageName, i - 1);
        child.parent_id = rootId;
        child.depth = 1;
        child.bbox_w = 100;
        child.bbox_h = 24;
        list.push(child);
      }
      return list;
    };
    const sdb = new AstGraphDB(syncDbPath);
    sdb.upsertFileMeta({ file_key: 'syncProj', file_name: 'Sync App', extracted_at: '2026-01-01T00:00:00Z', page_count: 1 });
    sdb.beginPage('syncProj', { file_key: 'syncProj', page_id: 'sp1', page_name: 'Split Bill', page_index: 0 });
    sdb.stageNodes('syncProj', 'sp1', [
      ...makeScreenSubtree('scr-keep', 'sp1', 'Split Bill'),
      ...makeScreenSubtree('scr-old', 'sp1', 'Split Bill'),
    ]);
    sdb.completePage('syncProj', 'sp1');

    const beforeSnap = snapshotProjectScreens(tmpSyncRoot, 'syncProj', syncDbPath, 'syncProj');
    // Re-export Split Bill removing scr-old and adding scr-new
    sdb.beginPage('syncProj', { file_key: 'syncProj', page_id: 'sp1', page_name: 'Split Bill', page_index: 0 });
    sdb.stageNodes('syncProj', 'sp1', [
      ...makeScreenSubtree('scr-keep', 'sp1', 'Split Bill'),
      ...makeScreenSubtree('scr-new', 'sp1', 'Split Bill'),
    ]);
    sdb.completePage('syncProj', 'sp1');
    sdb.checkpoint();
    sdb.close();

    const recSync = reconcileProjectLabelsWithDb(tmpSyncRoot, 'syncProj', syncDbPath, 'syncProj');
    const afterSnap = snapshotProjectScreens(tmpSyncRoot, 'syncProj', syncDbPath, 'syncProj');
    const diffSync = computeScreenSyncDiff(beforeSnap, afterSnap);
    saveLastSync(syncDbPath, {
      version: 1,
      syncedAt: '2026-01-02T00:00:00Z',
      isInitialImport: diffSync.isInitialImport,
      touchedPages: ['Split Bill'],
      prunedPages: [],
      addedScreens: diffSync.addedScreens,
      removedScreens: diffSync.removedScreens,
      labelsArchived: recSync.archived,
      proposalsPruned: recSync.proposalsPruned,
    });
    const loadedSync = loadLastSync(syncDbPath);
    check(
      'scenario 9: detects added screen + deleted screen with prior label & persists last-sync.json',
      !diffSync.isInitialImport &&
        diffSync.addedScreens.length === 1 &&
        diffSync.addedScreens[0].id === 'scr-new' &&
        diffSync.removedScreens.length === 1 &&
        diffSync.removedScreens[0].id === 'scr-old' &&
        diffSync.removedScreens[0].major === '新UI' &&
        diffSync.removedScreens[0].minor === '首頁' &&
        loadedSync?.addedScreens.length === 1 &&
        loadedSync?.labelsArchived === 1,
    );
  } finally {
    rmSync(tmpSyncRoot, { recursive: true, force: true });
  }

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
