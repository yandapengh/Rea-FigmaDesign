/// <reference lib="es2022" />
/**
 * Headless Live Bridge verification:
 *  - verifies BRIDGE_HELLO / BRIDGE_STATUS presence broadcasting
 *  - verifies BRIDGE_FOCUS_NODES -> figma-plugin -> BRIDGE_FOCUS_RESULT -> review-ui relay
 *  - verifies cross-page error forwarding and offline disconnect handling
 *  - verifies HTTP GET /review serves HTML when .scratch/review.html exists
 */

import assert = require('node:assert/strict');
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { startIngestServer } from './ws-server';

const ROOT = resolve(__dirname, '..');
const PORT = 8767;
const WS_URL = 'ws://127.0.0.1:' + PORT;

function connectWs(): Promise<WebSocket> {
  return new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(WS_URL);
    ws.once('open', () => resolveWs(ws));
    ws.once('error', rejectWs);
  });
}

function nextMessage(ws: WebSocket, predicate: (msg: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolveMsg, rejectMsg) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      rejectMsg(new Error('timeout waiting for message'));
    }, timeoutMs);
    const onMsg = (raw: Buffer | string): void => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolveMsg(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

function fetchHttp(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveHttp, rejectHttp) => {
    httpGet(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => resolveHttp({ status: res.statusCode ?? 0, body }));
    }).on('error', rejectHttp);
  });
}

async function main(): Promise<void> {
  const reviewPath = resolve(ROOT, '.scratch/review.html');
  const hadReview = existsSync(reviewPath);
  if (!hadReview) {
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, '<!doctype html><html><body>stub</body></html>', 'utf8');
  }
  const projReviewPath = resolve(ROOT, '.scratch/review-mockproj.html');
  const hadProjReview = existsSync(projReviewPath);
  writeFileSync(projReviewPath, '<!doctype html><html><body>mock-project</body></html>', 'utf8');

  const dbPath = resolve(ROOT, 'data/test-bridge.sqlite');
  const server = await startIngestServer({ port: PORT, dbPath, quiet: true });
  let reviewWs: WebSocket | null = null;
  let pluginWs: WebSocket | null = null;

  try {
    // 1. review-ui connects and receives initial BRIDGE_STATUS (figma_connected: false)
    reviewWs = await connectWs();
    const pInit = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_STATUS');
    reviewWs.send(JSON.stringify({ type: 'BRIDGE_HELLO', payload: { role: 'review-ui' } }));
    const initStatus = await pInit;
    assert.equal((initStatus.payload as { figma_connected: boolean }).figma_connected, false);
    console.log('  ok    review-ui hello -> initial BRIDGE_STATUS (offline)');

    // 2. figma-plugin connects -> review-ui receives figma_connected: true
    pluginWs = await connectWs();
    const pOnline = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_STATUS' && (m.payload as { figma_connected: boolean }).figma_connected === true);
    const pPluginStatus = nextMessage(pluginWs, (m) => m.type === 'BRIDGE_STATUS' && (m.payload as { review_clients: number }).review_clients === 1);
    pluginWs.send(JSON.stringify({ type: 'BRIDGE_HELLO', payload: { role: 'figma-plugin', file_key: 'f1', file_name: 'Mock File' } }));
    const onlineStatus = await pOnline;
    assert.equal((onlineStatus.payload as { figma_file_name?: string }).figma_file_name, 'Mock File');
    const pluginStatus = await pPluginStatus;
    assert.equal((pluginStatus.payload as { review_clients: number }).review_clients, 1);
    console.log('  ok    figma-plugin hello -> BRIDGE_STATUS broadcast (connected + review_clients)');

    // 3. Single-page focus relay succeeds
    const pPluginRecv = nextMessage(pluginWs, (m) => m.type === 'BRIDGE_FOCUS_NODES');
    const pReviewRecv = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_FOCUS_RESULT');
    reviewWs.send(JSON.stringify({
      type: 'BRIDGE_FOCUS_NODES',
      payload: { request_id: 'req-1', node_ids: ['1:1', '1:2', '1:1'], page_name: 'Home' },
    }));
    const forwarded = await pPluginRecv;
    assert.deepEqual((forwarded.payload as { node_ids: string[] }).node_ids, ['1:1', '1:2']);
    pluginWs.send(JSON.stringify({
      type: 'BRIDGE_FOCUS_RESULT',
      payload: { request_id: 'req-1', ok: true, page_id: '0:1', page_name: 'Home', selected_count: 2 },
    }));
    const res1 = await pReviewRecv;
    assert.equal((res1.payload as { ok: boolean; selected_count?: number }).ok, true);
    assert.equal((res1.payload as { selected_count?: number }).selected_count, 2);
    console.log('  ok    BRIDGE_FOCUS_NODES -> BRIDGE_FOCUS_RESULT relay (deduped)');

    // 3b. Page-only jump relay succeeds even with empty node_ids
    const pPluginPage = nextMessage(pluginWs, (m) => m.type === 'BRIDGE_FOCUS_NODES');
    const pReviewPage = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_FOCUS_RESULT');
    reviewWs.send(JSON.stringify({
      type: 'BRIDGE_FOCUS_NODES',
      payload: { request_id: 'req-page', node_ids: [], page_id: '0:1', page_name: 'Home', page_only: true },
    }));
    const fwdPage = await pPluginPage;
    assert.equal((fwdPage.payload as { page_only?: boolean }).page_only, true);
    pluginWs.send(JSON.stringify({
      type: 'BRIDGE_FOCUS_RESULT',
      payload: { request_id: 'req-page', ok: true, page_id: '0:1', page_name: 'Home', page_only: true, selected_count: 0 },
    }));
    const resPage = await pReviewPage;
    assert.equal((resPage.payload as { ok: boolean; page_only?: boolean }).ok, true);
    assert.equal((resPage.payload as { page_only?: boolean }).page_only, true);
    console.log('  ok    page_only jump relay succeeds');

    // 4. Cross-page error relay forwards accurately
    const pPluginRecv2 = nextMessage(pluginWs, (m) => m.type === 'BRIDGE_FOCUS_NODES');
    const pReviewRecv2 = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_FOCUS_RESULT');
    reviewWs.send(JSON.stringify({
      type: 'BRIDGE_FOCUS_NODES',
      payload: { request_id: 'req-2', node_ids: ['1:1', '2:1'] },
    }));
    await pPluginRecv2;
    pluginWs.send(JSON.stringify({
      type: 'BRIDGE_FOCUS_RESULT',
      payload: {
        request_id: 'req-2',
        ok: false,
        cross_page_pages: [{ page_id: '0:1', page_name: 'A', count: 1 }, { page_id: '0:2', page_name: 'B', count: 1 }],
        error: '目標節點跨越多個 Figma 頁面，請按單頁逐一跳轉',
      },
    }));
    const res2 = await pReviewRecv2;
    assert.equal((res2.payload as { ok: boolean }).ok, false);
    assert.equal((res2.payload as { cross_page_pages?: unknown[] }).cross_page_pages?.length, 2);
    console.log('  ok    cross-page refusal forwarded to review-ui');

    // 4b. Reverse lookup relay: figma-plugin -> review-ui -> figma-plugin
    const pReviewLookup = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_LOOKUP_SELECTION');
    const pPluginLookupRes = nextMessage(pluginWs, (m) => m.type === 'BRIDGE_LOOKUP_RESULT');
    pluginWs.send(JSON.stringify({
      type: 'BRIDGE_LOOKUP_SELECTION',
      payload: {
        request_id: 'lk-1',
        file_key: 'f1',
        file_name: 'Mock File',
        page_id: '0:1',
        page_name: 'Home',
        items: [
          { id: '1:1', name: 'Recorded Frame', type: 'FRAME', page_id: '0:1', page_name: 'Home' },
          { id: '9:9', name: 'New Frame', type: 'FRAME', page_id: '0:1', page_name: 'Home', width: 390, height: 844, text_preview: 'New screen' },
        ],
      },
    }));
    const fwdLookup = await pReviewLookup;
    assert.equal((fwdLookup.payload as { items: unknown[] }).items.length, 2);
    reviewWs.send(JSON.stringify({
      type: 'BRIDGE_LOOKUP_RESULT',
      payload: { request_id: 'lk-1', ok: true, total: 2, matched_count: 1, unrecorded_count: 1 },
    }));
    const lookupRes = await pPluginLookupRes;
    assert.equal((lookupRes.payload as { ok: boolean }).ok, true);
    assert.equal((lookupRes.payload as { matched_count?: number }).matched_count, 1);
    assert.equal((lookupRes.payload as { unrecorded_count?: number }).unrecorded_count, 1);
    console.log('  ok    BRIDGE_LOOKUP_SELECTION -> BRIDGE_LOOKUP_RESULT relay');

    // 4c. Review-ui disconnect rejects subsequent lookup from figma-plugin
    const pReviewOffline = nextMessage(pluginWs, (m) => m.type === 'BRIDGE_STATUS' && (m.payload as { review_clients: number }).review_clients === 0);
    reviewWs.close();
    reviewWs = null;
    await pReviewOffline;
    const pLookupFail = nextMessage(pluginWs, (m) => m.type === 'BRIDGE_LOOKUP_RESULT');
    pluginWs.send(JSON.stringify({
      type: 'BRIDGE_LOOKUP_SELECTION',
      payload: {
        request_id: 'lk-2',
        page_id: '0:1',
        page_name: 'Home',
        items: [{ id: '1:1', name: 'Recorded Frame', type: 'FRAME', page_id: '0:1', page_name: 'Home' }],
      },
    }));
    const lookupFailRes = await pLookupFail;
    assert.equal((lookupFailRes.payload as { ok: boolean }).ok, false);
    console.log('  ok    offline review-ui guard rejects lookup immediately');

    // Reconnect review-ui for step 4d & step 5 (plugin disconnect test)
    reviewWs = await connectWs();
    const pRehello = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_STATUS' && (m.payload as { figma_connected: boolean }).figma_connected === true);
    reviewWs.send(JSON.stringify({ type: 'BRIDGE_HELLO', payload: { role: 'review-ui' } }));
    await pRehello;

    // 4d. Cross-project focus mismatch guard rejects targeting a different Figma file
    const pMismatchRes = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_FOCUS_RESULT');
    reviewWs.send(JSON.stringify({
      type: 'BRIDGE_FOCUS_NODES',
      payload: { request_id: 'req-mismatch', node_ids: ['1:1'], file_key: 'other-key', file_name: 'Other Project' },
    }));
    const mismatchRes = await pMismatchRes;
    assert.equal((mismatchRes.payload as { ok: boolean }).ok, false);
    assert.ok(String((mismatchRes.payload as { error?: string }).error || '').includes('不符'));
    console.log('  ok    cross-project focus mismatch rejected cleanly');

    // 4e. Stage board relay: review-ui -> figma-plugin -> review-ui (deduped)
    const pPluginStage = nextMessage(pluginWs, (m) => m.type === 'BRIDGE_STAGE_BOARD');
    const pReviewStageRes = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_STAGE_RESULT');
    reviewWs.send(JSON.stringify({
      type: 'BRIDGE_STAGE_BOARD',
      payload: { request_id: 'stg-1', node_ids: ['1:1', '1:2', '1:1'], title: 'NFC 彈窗', target_page_id: '0:1' },
    }));
    const fwdStage = await pPluginStage;
    assert.deepEqual((fwdStage.payload as { node_ids: string[] }).node_ids, ['1:1', '1:2']);
    assert.equal((fwdStage.payload as { title?: string }).title, 'NFC 彈窗');
    pluginWs.send(JSON.stringify({
      type: 'BRIDGE_STAGE_RESULT',
      payload: { request_id: 'stg-1', ok: true, section_id: '99:1', section_name: '[Rea 臨時預覽 · 可刪除] NFC 彈窗 (2)', page_id: '0:1', page_name: 'Home', staged_count: 2 },
    }));
    const stageRes = await pReviewStageRes;
    assert.equal((stageRes.payload as { ok: boolean }).ok, true);
    assert.equal((stageRes.payload as { staged_count?: number }).staged_count, 2);
    console.log('  ok    BRIDGE_STAGE_BOARD -> BRIDGE_STAGE_RESULT relay (deduped)');

    // 5. Plugin disconnect updates status and immediately rejects subsequent focus requests
    const pOffline = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_STATUS' && (m.payload as { figma_connected: boolean }).figma_connected === false);
    pluginWs.close();
    pluginWs = null;
    await pOffline;
    const pFailOffline = nextMessage(reviewWs, (m) => m.type === 'BRIDGE_FOCUS_RESULT');
    reviewWs.send(JSON.stringify({
      type: 'BRIDGE_FOCUS_NODES',
      payload: { request_id: 'req-3', node_ids: ['1:1'] },
    }));
    const res3 = await pFailOffline;
    assert.equal((res3.payload as { ok: boolean }).ok, false);
    console.log('  ok    offline plugin guard returns immediate error');

    // 6. HTTP GET /review and /review-<project>.html serve 200 HTML
    const httpRes = await fetchHttp('http://127.0.0.1:' + PORT + '/review');
    assert.equal(httpRes.status, 200);
    assert.ok(httpRes.body.includes('<html') || httpRes.body.includes('<!doctype html'));
    const projHttpRes = await fetchHttp('http://127.0.0.1:' + PORT + '/review-mockproj.html');
    assert.equal(projHttpRes.status, 200);
    assert.ok(projHttpRes.body.includes('mock-project'));
    console.log('  ok    HTTP GET /review and /review-<id>.html serve 200 HTML');

    // 7. Isolated RESET_DATABASE resets only the active DB (requires socket DB or fixedDb)
    pluginWs = await connectWs();
    const pSyncAck = nextMessage(pluginWs, (m) => m.receivedType === 'SYNC_START');
    pluginWs.send(JSON.stringify({
      type: 'SYNC_START',
      payload: { file_key: 'f1', file_name: 'Mock File', extracted_at: new Date().toISOString(), page_count: 1 },
    }));
    await pSyncAck;
    const pResetAck = nextMessage(pluginWs, (m) => m.receivedType === 'RESET_DATABASE');
    pluginWs.send(JSON.stringify({ type: 'RESET_DATABASE', payload: { confirm: true, file_key: 'f1' } }));
    const resetAck = await pResetAck;
    assert.equal(resetAck.status, 'OK');
    console.log('  ok    RESET_DATABASE scoped to active database');

    console.log('');
    console.log('RESULT: OK — Live Bridge relay, status sync and HTTP route verified');
  } finally {
    reviewWs?.close();
    pluginWs?.close();
    await server.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
    if (!hadReview) rmSync(reviewPath, { force: true });
    if (!hadProjReview) rmSync(projReviewPath, { force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
