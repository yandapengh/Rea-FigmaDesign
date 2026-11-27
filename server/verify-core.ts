/// <reference lib="es2022" />
/**
 * Unit/regression tests for server/core modules using an isolated temp SQLite graph.
 */

import assert = require('node:assert/strict');
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeRow } from '../shared/protocol';
import { AstGraphDB } from './db';
import { Graph, findScreenRootCandidates, findScreenRoots } from './core/graph';
import { labelsPathForProject } from './core/projects';
import { uxFeatures } from './core/ux';
import { onionHashes } from './core/onion';
import { detachFeature, detachScore } from './core/detach';
import { categoryReportV2, recomputeV2Counts, summarizeCategoriesV2, type ScreenLabelV2 } from './core/semantics';
import { matchesSearch, normSearchText } from './core/search-zh';

function makeNode(overrides: Partial<NodeRow> & { id: string }): NodeRow {
  return {
    parent_id: null,
    page_id: '0:1',
    page_name: 'Page 1',
    child_index: 0,
    depth: 0,
    type: 'FRAME',
    name: 'Node ' + overrides.id,
    visible: 1,
    main_component_id: null,
    is_icon_container: 0,
    layout_mode: 'NONE',
    layout_props_json: '{}',
    bbox_x: 0,
    bbox_y: 0,
    bbox_w: 100,
    bbox_h: 40,
    style_json: '{}',
    bound_variables_json: '{}',
    text_content: null,
    text_style_json: null,
    reactions_json: null,
    ...overrides,
  };
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'rea-figma-core-'));
  const dbPath = join(dir, 'test.sqlite');
  try {
    const db = new AstGraphDB(dbPath);
    const fileKey = 'test-key';
    db.upsertFileMeta({ file_key: fileKey, file_name: 'Test File', extracted_at: '2026-11-24T00:00:00.000Z', page_count: 1 });
    db.beginPage(fileKey, { file_key: fileKey, page_id: '0:1', page_name: 'Page 1', page_index: 0, child_count: 2, is_empty: 0 });

    const rows: NodeRow[] = [];
    // Screen 1: 390x844 with 45 children so subtree >= 40, testing listRun = [A, A, B, A, A] -> maxRun=2 (0.25 before normalization? Wait: (2-1)/45)
    rows.push(makeNode({ id: 's1', bbox_w: 390, bbox_h: 844, name: 'Screen 1' }));
    // Children 0..1: identical RECTANGLEs
    rows.push(makeNode({ id: 's1:0', parent_id: 's1', child_index: 0, depth: 1, type: 'RECTANGLE', bbox_y: 10 }));
    rows.push(makeNode({ id: 's1:1', parent_id: 's1', child_index: 1, depth: 1, type: 'RECTANGLE', bbox_y: 60 }));
    // Child 2: TEXT (breaks the run!)
    rows.push(makeNode({ id: 's1:2', parent_id: 's1', child_index: 2, depth: 1, type: 'TEXT', text_content: 'Divider', bbox_y: 110 }));
    // Children 3..4: identical RECTANGLEs again (total adjacent pairs = 2, maxRun = 2!)
    rows.push(makeNode({ id: 's1:3', parent_id: 's1', child_index: 3, depth: 1, type: 'RECTANGLE', bbox_y: 160 }));
    rows.push(makeNode({ id: 's1:4', parent_id: 's1', child_index: 4, depth: 1, type: 'RECTANGLE', bbox_y: 210 }));
    // Children 5..44: distinct-type or nested filler so total subtree >= 40 without creating a run > 2
    for (let i = 5; i < 45; i += 1) {
      rows.push(makeNode({
        id: 's1:' + i,
        parent_id: 's1',
        child_index: i,
        depth: 1,
        type: i % 2 === 0 ? 'ELLIPSE' : 'TEXT',
        text_content: i % 2 === 1 ? 'Item ' + i : null,
        bbox_y: 260 + i * 10,
      }));
    }

    // Nested 390x844 inside s1 (should be excluded by findScreenRootCandidates)
    rows.push(makeNode({ id: 's1:nested', parent_id: 's1', child_index: 45, depth: 1, type: 'FRAME', bbox_w: 390, bbox_h: 844 }));

    // Small 390x844 screen with < 40 nodes (candidate, but excluded by findScreenRoots(..., 40))
    rows.push(makeNode({ id: 's2', bbox_w: 390, bbox_h: 844, name: 'Tiny Screen' }));
    rows.push(makeNode({ id: 's2:0', parent_id: 's2', child_index: 0, depth: 1, type: 'TEXT', text_content: 'Hi' }));

    // Long scrolling 390x1800 mobile screen (candidate under DEFAULT_SCREEN_SPEC, excluded if maxHeight=900)
    rows.push(makeNode({ id: 's3', bbox_w: 390, bbox_h: 1800, name: 'Long Scroll Screen' }));
    rows.push(makeNode({ id: 's3:0', parent_id: 's3', child_index: 0, depth: 1, type: 'TEXT', text_content: 'Scroll' }));

    // Deep linear chain (depth 120) to verify iterative onionHashes never overflows or crashes
    rows.push(makeNode({ id: 'chain:0', parent_id: null, child_index: 0, depth: 0, type: 'FRAME' }));
    for (let d = 1; d <= 120; d += 1) {
      rows.push(makeNode({ id: 'chain:' + d, parent_id: 'chain:' + (d - 1), child_index: 0, depth: d, type: d === 120 ? 'TEXT' : 'FRAME', text_content: d === 120 ? 'Leaf' : null }));
    }

    db.stageNodes(fileKey, '0:1', rows);
    db.completePage(fileKey, '0:1', rows.length);
    db.close();

    const g = new Graph(dbPath);

    // 1. findScreenRootCandidates & findScreenRoots (including long page + custom ScreenSpec)
    const cands = findScreenRootCandidates(g);
    assert.deepEqual(cands, ['s1', 's2', 's3']);
    const strictCands = findScreenRootCandidates(g, { maxHeight: 900 });
    assert.deepEqual(strictCands, ['s1', 's2']);
    const roots = findScreenRoots(g, 40);
    assert.deepEqual(roots, ['s1']);

    // 1b. project isolation label path resolver
    assert.ok(labelsPathForProject(dir, 'project-b').endsWith('labels/projects/project-b/screens-v2.json'));
    assert.ok(labelsPathForProject(join(__dirname, '..'), 'file-1d40063501').endsWith('labels/screens-v2.json'));

    // 2. uxFeatures listRun bug fix: maxRun must be 2, not 3 (46 direct kids on s1)
    const ux = uxFeatures(g, 's1');
    const listRunIdx = 6; // 'listRun'
    assert.ok(Math.abs(ux[listRunIdx] - (2 - 1) / 46) < 1e-9, 'expected maxRun=2 -> (2-1)/46, got ' + ux[listRunIdx]);

    // 3. iterative onionHashes handles depth 120 & transparent shell collapse
    const oh = onionHashes(g, dbPath);
    assert.ok(oh.has('chain:0'));
    assert.equal(oh.get('chain:0'), oh.get('chain:120'), 'transparent single-child chain should collapse to leaf hash');

    // 4. detachScore with shared cosine
    const f1 = detachFeature(g, 's1');
    const selfScore = detachScore(f1, f1);
    assert.ok(Math.abs(selfScore.score - 1) < 1e-9, 'self detachScore must equal 1');

    // 5. v2 category helpers (minor, slash, major fallback, missing -> null, recomputeV2Counts)
    const sampleLabels: ScreenLabelV2[] = [
      { id: 's1', label: '掃碼收款/支付', major: '頁面類', minor: '掃碼收款/支付', generation: 'new' },
      { id: 's2', label: '老UI', major: '老UI', minor: '', generation: 'old' },
    ];
    const pageById = new Map([['s1', 'Pay Page'], ['s2', 'Legacy Page']]);
    assert.deepEqual(recomputeV2Counts(sampleLabels), { '頁面類': 1, '老UI': 1 });
    const catList = summarizeCategoriesV2(sampleLabels, pageById);
    assert.equal(catList.length, 2);
    const slashReport = categoryReportV2(sampleLabels, '掃碼收款/支付', pageById);
    assert.equal(slashReport?.total, 1);
    const majorReport = categoryReportV2(sampleLabels, '頁面類', pageById);
    assert.equal(majorReport?.total, 1);
    assert.equal(categoryReportV2(sampleLabels, '不存在分類', pageById), null);

    // 6. Simplified/Traditional Chinese insensitive multi-token search
    assert.equal(matchesSearch('新UI / 通用彈窗', '弹窗'), true);
    assert.equal(matchesSearch('新UI / 下拉抽屜彈窗', '抽屉 弹窗'), true);
    assert.equal(matchesSearch('新UI / 交易詳情', '详情'), true);
    assert.equal(matchesSearch('新UI / MGM详情页', '詳情頁'), true);
    assert.equal(matchesSearch('新UI / 分帳確認彈窗', '分账'), true);
    assert.equal(matchesSearch('新UI / 分账记录list', '分帳 記錄'), true);
    assert.equal(matchesSearch('新UI / 收銀台', '弹窗'), false);
    assert.equal(normSearchText('彈窗詳情'), '弹窗详情');

    console.log('  ok    findScreenRootCandidates & findScreenRoots');
    console.log('  ok    uxFeatures listRun consecutive maxRun');
    console.log('  ok    iterative onionHashes deep chain & shell collapse');
    console.log('  ok    detachScore shared cosine');
    console.log('  ok    semantics v2 category summary & report');
    console.log('  ok    search-zh simplified/traditional multi-token match');
    console.log('');
    console.log('RESULT: OK — core helpers & bug fixes verified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
