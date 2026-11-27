/// <reference lib="es2022" />
/**
 * Workspace & Multi-File Combination Verification (Step 2):
 *  - verifies real fileName identification + colliding node IDs (e.g. 10:1 in A1 and A2)
 *  - verifies shared screenSpec filtering (mobile vs PC web) without mixing SQLite DBs
 *  - verifies workspace review-<wsId>.html generation + inline JS syntax validity
 *  - verifies composite reconciliation (deleting 10:1 from A2 preserves A1::10:1)
 *  - verifies HTTP POST /api/workspaces, POST /api/apply-proposals, and WS BRIDGE_LOOKUP_SELECTION routing
 */

import assert = require('node:assert/strict');
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, get as httpGet } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { AstGraphDB } from './db';
import {
  DEFAULT_SCREEN_SPEC,
  deleteWorkspace,
  listWorkspaces,
  makeCompositeScreenId,
  PC_WEB_SCREEN_SPEC,
  reconcileWorkspaceLabelsWithDbs,
  resolveWorkspace,
  saveWorkspaceConfig,
} from './core/projects';
import { generateReviewBoard } from './review-board';
import { generateProjectHub } from './review-hub';
import { startIngestServer } from './ws-server';
import type { NodeRow } from '../shared/protocol';

const ROOT = resolve(__dirname, '..');
const PORT = 8769;
const WS_URL = 'ws://127.0.0.1:' + PORT;

const P_A1 = 'file-wsver-a1';
const P_A2 = 'file-wsver-a2';
const WS_ID = 'ws-wsver-app';

function makeFrame(id: string, pageId: string, pageName: string, name: string, w: number, h: number, idx: number): NodeRow {
  return {
    id,
    parent_id: null,
    page_id: pageId,
    page_name: pageName,
    child_index: idx,
    depth: 0,
    type: 'FRAME',
    name,
    visible: 1,
    main_component_id: null,
    is_icon_container: 0,
    layout_mode: 'NONE',
    layout_props_json: '{}',
    bbox_x: idx * 500,
    bbox_y: 0,
    bbox_w: w,
    bbox_h: h,
    style_json: '{}',
    bound_variables_json: '{}',
    text_content: null,
    text_style_json: null,
    reactions_json: null,
  };
}

function makeTextChild(id: string, parentId: string, pageId: string, pageName: string, text: string, idx: number): NodeRow {
  return {
    id,
    parent_id: parentId,
    page_id: pageId,
    page_name: pageName,
    child_index: idx,
    depth: 1,
    type: 'TEXT',
    name: 'Title',
    visible: 1,
    main_component_id: null,
    is_icon_container: 0,
    layout_mode: 'NONE',
    layout_props_json: '{}',
    bbox_x: 16,
    bbox_y: 24,
    bbox_w: 200,
    bbox_h: 28,
    style_json: '{}',
    bound_variables_json: '{}',
    text_content: text,
    text_style_json: null,
    reactions_json: null,
  };
}

function seedProject(projectId: string, fileKey: string, fileName: string, specs: Array<{ id: string; pageId: string; pageName: string; name: string; w: number; h: number; text: string }>): void {
  const dir = join(ROOT, 'data', projectId);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'graph.sqlite');
  const db = new AstGraphDB(dbPath);
  db.upsertFileMeta({ file_key: fileKey, file_name: fileName, extracted_at: '2026-11-27T00:00:00Z', page_count: specs.length });
  specs.forEach((s, i) => {
    db.beginPage(fileKey, { file_key: fileKey, page_id: s.pageId, page_name: s.pageName, page_index: i });
    db.stageNodes(fileKey, s.pageId, [
      makeFrame(s.id, s.pageId, s.pageName, s.name, s.w, s.h, 0),
      makeTextChild(s.id + '-t', s.id, s.pageId, s.pageName, s.text, 0),
    ]);
    db.completePage(fileKey, s.pageId, 2);
  });
  db.finalizeSync(fileKey, specs.length * 2);
  db.checkpoint();
  db.close();
}

function assertInlineScriptCompiles(htmlPath: string, label: string): string {
  const html = readFileSync(htmlPath, 'utf8');
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(matches.length > 0, label + ' must contain <script>');
  for (let i = 0; i < matches.length; i += 1) {
    new Function(matches[i][1]);
  }
  return html;
}

function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolvePost, rejectPost) => {
    const raw = JSON.stringify(body);
    const req = httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += String(c); });
      res.on('end', () => {
        resolvePost({ status: res.statusCode ?? 0, json: JSON.parse(buf) as Record<string, unknown> });
      });
    });
    req.on('error', rejectPost);
    req.write(raw);
    req.end();
  });
}

function fetchHttp(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveGet, rejectGet) => {
    httpGet(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += String(c); });
      res.on('end', () => resolveGet({ status: res.statusCode ?? 0, body: buf }));
    }).on('error', rejectGet);
  });
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(WS_URL);
    ws.once('open', () => resolveWs(ws));
    ws.once('error', rejectWs);
  });
}

function nextMessage(ws: WebSocket, predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolveMsg, rejectMsg) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      rejectMsg(new Error('timeout waiting for WS message'));
    }, timeoutMs);
    const onMsg = (raw: Buffer | string): void => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolveMsg(m);
      }
    };
    ws.on('message', onMsg);
  });
}

async function main(): Promise<void> {
  const tempPaths = [
    join(ROOT, 'data', P_A1),
    join(ROOT, 'data', P_A2),
    join(ROOT, 'data', 'test-workspaces-bridge.sqlite'),
    join(ROOT, 'labels', 'projects', P_A1),
    join(ROOT, 'labels', 'projects', P_A2),
    join(ROOT, 'labels', 'workspaces', WS_ID),
    join(ROOT, '.scratch', 'review-' + P_A1 + '.html'),
    join(ROOT, '.scratch', 'review-' + P_A2 + '.html'),
    join(ROOT, '.scratch', 'review-' + WS_ID + '.html'),
  ];
  let createdWsId = '';
  let server: Awaited<ReturnType<typeof startIngestServer>> | null = null;
  let reviewWs: WebSocket | null = null;
  let pluginWs: WebSocket | null = null;

  try {
    // Seed two separate files that both use colliding node ID "10:1"
    seedProject(P_A1, 'key-wsver-a1', 'Mobile App A1', [
      { id: '10:1', pageId: '0:1', pageName: 'Login', name: 'A1 Login Screen', w: 390, h: 844, text: 'Welcome A1' },
      { id: '20:1', pageId: '0:2', pageName: 'Desktop Spec', name: 'A1 Desktop Frame', w: 1440, h: 900, text: 'Desktop A1' },
    ]);
    seedProject(P_A2, 'key-wsver-a2', 'Mobile App A2', [
      { id: '10:1', pageId: '0:1', pageName: 'Transfer', name: 'A2 Transfer Screen', w: 390, h: 844, text: 'Transfer A2' },
      { id: '30:1', pageId: '0:3', pageName: 'Profile', name: 'A2 Profile Screen', w: 390, h: 844, text: 'Profile A2' },
    ]);

    // 1. Create workspace with mobile spec (minNodes: 2 for synthetic 2-node screens)
    saveWorkspaceConfig(ROOT, {
      id: WS_ID,
      name: '手機應用 A（A1+A2）',
      sources: [P_A1, P_A2],
      screenSpec: { ...DEFAULT_SCREEN_SPEC, widths: [390], minNodes: 2, minHeight: 600, maxHeight: 12000 },
    });
    const wsList = listWorkspaces(ROOT);
    const ws = wsList.find((w) => w.id === WS_ID);
    assert.ok(ws, 'workspace should appear in listWorkspaces');
    assert.equal(ws.sources.length, 2);

    // 2. Verify workspace board keeps BOTH colliding 10:1 screens under composite keys & filters out 1440px frame
    const board = generateReviewBoard({ projectId: WS_ID, open: false });
    assert.equal(board.unique, 3, 'mobile screenSpec should keep A1::10:1, A2::10:1, A2::30:1 (and skip 1440px)');
    const wsHtml = assertInlineScriptCompiles(board.html, 'workspace review board');
    assert.ok(wsHtml.includes(makeCompositeScreenId(P_A1, '10:1')), 'composite ID for A1::10:1 must exist');
    assert.ok(wsHtml.includes(makeCompositeScreenId(P_A2, '10:1')), 'composite ID for A2::10:1 must exist');
    assert.ok(wsHtml.includes('Mobile App A1') && wsHtml.includes('Mobile App A2'), 'real Figma source fileNames must render');
    assert.ok(wsHtml.includes('sb-source-picker') && wsHtml.includes('data-pick-source') && wsHtml.includes('rawPageName'), 'per-file sidebar page switcher must render cleanly');

    // 3. Switch shared screenSpec to PC Web -> picks only the 1440x900 screen across merged sources
    saveWorkspaceConfig(ROOT, {
      id: WS_ID,
      name: '手機應用 A（PC Rule Check）',
      sources: [P_A1, P_A2],
      screenSpec: { ...PC_WEB_SCREEN_SPEC, minNodes: 2 },
    });
    const pcBoard = generateReviewBoard({ projectId: WS_ID, open: false });
    assert.equal(pcBoard.unique, 1, 'PC web screenSpec should match only the 1440x900 desktop frame');

    // Switch back to mobile spec for labeling + HTTP/WS checks
    saveWorkspaceConfig(ROOT, {
      id: WS_ID,
      name: '手機應用 A（A1+A2）',
      sources: [P_A1, P_A2],
      screenSpec: { ...DEFAULT_SCREEN_SPEC, widths: [390], minNodes: 2, minHeight: 600, maxHeight: 12000 },
    });

    // 4. Hub generation + inline JS compile check
    const hub = generateProjectHub(ROOT);
    const hubHtml = assertInlineScriptCompiles(hub.html, 'project hub');
    assert.ok(hubHtml.includes('手機應用 A（A1+A2）'), 'Hub should include workspace name');
    assert.ok(hubHtml.includes('Mobile App A1'), 'Hub should display real Figma fileName');

    // 5. Start server & test HTTP /api/workspaces + /api/apply-proposals + WS source_files routing
    server = await startIngestServer({ port: PORT, dbPath: join(ROOT, 'data', 'test-workspaces-bridge.sqlite'), quiet: true });

    const createRes = await postJson('http://127.0.0.1:' + PORT + '/api/workspaces', {
      action: 'save',
      name: 'HTTP Created App',
      sourceIds: [P_A1, P_A2],
      screenSpec: { widths: [390], minNodes: 2 },
    });
    assert.equal(createRes.status, 200);
    assert.equal(createRes.json.ok, true);
    const createdObj = createRes.json.workspace as { id: string };
    createdWsId = createdObj.id;
    assert.ok(createdWsId.startsWith('ws-'));
    tempPaths.push(join(ROOT, 'labels', 'workspaces', createdWsId));
    tempPaths.push(join(ROOT, '.scratch', 'review-' + createdWsId + '.html'));
    assert.ok(resolveWorkspace(ROOT, createdWsId), 'HTTP-created workspace must resolve');

    // Apply labels via /api/apply-proposals to both colliding IDs in WS_ID
    const idA1 = makeCompositeScreenId(P_A1, '10:1');
    const idA2 = makeCompositeScreenId(P_A2, '10:1');
    const applyRes = await postJson('http://127.0.0.1:' + PORT + '/api/apply-proposals', {
      projectId: WS_ID,
      confirm: true,
      items: [
        { id: idA1, major: '新UI', minor: '登入頁', generation: 'new' },
        { id: idA2, major: '新UI', minor: '轉帳頁', generation: 'new' },
      ],
    });
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.json.applied, 2);

    // Verify invalid composite ID gets rejected cleanly
    const badApplyRes = await postJson('http://127.0.0.1:' + PORT + '/api/apply-proposals', {
      projectId: WS_ID,
      confirm: true,
      items: [{ id: P_A1 + '::999:999', major: '新UI', minor: '不存在', generation: 'new' }],
    });
    assert.equal(badApplyRes.status, 400);

    // 6. Test composite reconciliation: remove 10:1 from A2 only, ensure A1::10:1 remains labeled!
    const dbA2 = new AstGraphDB(join(ROOT, 'data', P_A2, 'graph.sqlite'));
    dbA2.beginPage('key-wsver-a2', { file_key: 'key-wsver-a2', page_id: '0:1', page_name: 'Transfer', page_index: 0 });
    dbA2.completePage('key-wsver-a2', '0:1', 0);
    dbA2.finalizeSync('key-wsver-a2', 2);
    dbA2.checkpoint();
    dbA2.close();

    const wsAfter = resolveWorkspace(ROOT, WS_ID)!;
    const recRes = reconcileWorkspaceLabelsWithDbs(ROOT, wsAfter);
    assert.equal(recRes.archived, 1, 'only deleted A2::10:1 label should be archived');
    const wsLabelsDoc = JSON.parse(readFileSync(wsAfter.labelsPath, 'utf8')) as {
      screens: Array<{ id: string; minor: string }>;
      archivedDeleted?: Array<{ id: string }>;
    };
    assert.ok(wsLabelsDoc.screens.some((s) => s.id === idA1 && s.minor === '登入頁'), 'A1::10:1 label must remain');
    assert.ok(!wsLabelsDoc.screens.some((s) => s.id === idA2), 'A2::10:1 must be removed from active screens');
    assert.ok((wsLabelsDoc.archivedDeleted ?? []).some((s) => s.id === idA2), 'A2::10:1 must be backed up in archivedDeleted');

    // 7. Test Live Bridge routing using workspace source_files when A2 plugin sends BRIDGE_LOOKUP_SELECTION
    reviewWs = await connectWs();
    pluginWs = await connectWs();
    reviewWs.send(JSON.stringify({
      type: 'BRIDGE_HELLO',
      payload: {
        role: 'review-ui',
        project_id: WS_ID,
        source_files: [
          { file_key: 'key-wsver-a1', file_name: 'Mobile App A1' },
          { file_key: 'key-wsver-a2', file_name: 'Mobile App A2' },
        ],
      },
    }));
    pluginWs.send(JSON.stringify({
      type: 'BRIDGE_HELLO',
      payload: { role: 'figma-plugin', file_key: 'key-wsver-a2', file_name: 'Mobile App A2' },
    }));
    await nextMessage(reviewWs, (m) => m.type === 'BRIDGE_STATUS' && (m.payload as { figma_connected?: boolean })?.figma_connected === true);

    const lookupProm = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_LOOKUP_SELECTION');
    pluginWs.send(JSON.stringify({
      type: 'BRIDGE_LOOKUP_SELECTION',
      payload: {
        request_id: 'ws-lk-1',
        file_key: 'key-wsver-a2',
        file_name: 'Mobile App A2',
        items: [{ id: '30:1', name: 'A2 Profile Screen', type: 'FRAME', page_id: '0:3', page_name: 'Profile' }],
      },
    }));
    const relayedLookup = await lookupProm;
    assert.equal((relayedLookup.payload as { file_key?: string }).file_key, 'key-wsver-a2');

    // 8. Test HTTP delete workspace + GET HTML route
    const httpBoard = await fetchHttp('http://127.0.0.1:' + PORT + '/review-' + WS_ID + '.html');
    assert.equal(httpBoard.status, 200);
    const delRes = await postJson('http://127.0.0.1:' + PORT + '/api/workspaces', { action: 'delete', id: createdWsId });
    assert.equal(delRes.status, 200);
    assert.equal(resolveWorkspace(ROOT, createdWsId), null);
    assert.equal(deleteWorkspace(ROOT, WS_ID), true);

    console.log('verify-workspaces passed (colliding composite IDs, shared screenSpec, HTTP CRUD/apply-proposals, reconcile, WS routing)');
  } finally {
    if (reviewWs) reviewWs.close();
    if (pluginWs) pluginWs.close();
    if (server) await server.close();
    for (const p of tempPaths) {
      for (const sfx of ['', '-wal', '-shm']) {
        if (existsSync(p + sfx)) rmSync(p + sfx, { recursive: true, force: true });
      }
    }
    generateProjectHub(ROOT);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
