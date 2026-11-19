/// <reference lib="es2022" />
/** Stage 1 WS contract: PAGE_START -> CHUNK_NODES -> PAGE_COMPLETE -> PAGE_STATUS -> RESET. */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startIngestServer } from './ws-server';
import type { NodeRow } from '../shared/protocol';

const DB_PATH = join(tmpdir(), 'rea-figma-stage1-ws-' + process.pid + '.sqlite');
let failures = 0;

function check(name: string, ok: boolean, detail: string = ''): void {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures += 1;
}

function node(id: string, pageId: string, pageName: string, index: number): NodeRow {
  return {
    id, parent_id: null, page_id: pageId, page_name: pageName, child_index: index, depth: 0,
    type: 'FRAME', name: id, visible: 1, main_component_id: null, is_icon_container: 0,
    layout_mode: 'NONE', layout_props_json: '{}', bbox_x: 0, bbox_y: 0, bbox_w: 390, bbox_h: 844,
    style_json: '{}', bound_variables_json: '{}', text_content: null, text_style_json: null, reactions_json: null,
  };
}

async function main(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  const server = await startIngestServer({ port: 0, dbPath: DB_PATH, quiet: true });
  const address = server.wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const socket = new WebSocket('ws://127.0.0.1:' + port);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', () => resolveOpen());
    socket.once('error', (error) => rejectOpen(error));
  });

  const queue: number[] = [];
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  socket.on('message', (data: WebSocket.RawData) => {
    const id = queue.shift();
    if (id === undefined) return;
    const settle = waiters.get(id);
    if (settle) {
      waiters.delete(id);
      settle(JSON.parse(data.toString()) as Record<string, unknown>);
    }
  });
  let seq = 0;
  const call = (message: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolveCall, rejectCall) => {
      const id = ++seq;
      queue.push(id);
      const timer = setTimeout(() => rejectCall(new Error('ack timeout')), 8000);
      waiters.set(id, (m) => {
        clearTimeout(timer);
        resolveCall(m);
      });
      socket.send(JSON.stringify(message));
    });

  const start = await call({ type: 'SYNC_START', payload: { file_key: 'wsFile', file_name: 'WS File', extracted_at: '2026-01-03T00:00:00Z', page_count: 1 } });
  check('ws: SYNC_START acked', start.status === 'OK');
  const begin = await call({ type: 'PAGE_START', payload: { file_key: 'wsFile', page_id: 'wP', page_name: 'WS Page', page_index: 0 } });
  check('ws: PAGE_START acked', begin.status === 'OK');
  const chunk = await call({ type: 'CHUNK_NODES', payload: [node('w1', 'wP', 'WS Page', 0), node('w2', 'wP', 'WS Page', 1)] });
  check('ws: CHUNK_NODES stages 2 rows', chunk.status === 'OK' && chunk.count === 2);
  const done = await call({ type: 'PAGE_COMPLETE', payload: { file_key: 'wsFile', page_id: 'wP', total_nodes: 2 } });
  check('ws: PAGE_COMPLETE commits 2 rows', done.status === 'OK' && done.committed === 2);
  const status = await call({ type: 'PAGE_STATUS', payload: {} });
  const pages = (status.pages as Array<{ status: string; node_count: number }>) ?? [];
  check('ws: PAGE_STATUS reports DONE', pages.length === 1 && pages[0].status === 'DONE' && pages[0].node_count === 2);
  check('ws: PAGE_STATUS exposes the latest batch', Boolean(status.latestBatch));
  const refused = await call({ type: 'RESET_DATABASE', payload: {} });
  check('ws: RESET_DATABASE without confirm is refused', refused.status === 'ERROR');
  const reset = await call({ type: 'RESET_DATABASE', payload: { confirm: true } });
  check('ws: RESET_DATABASE with confirm succeeds', reset.status === 'OK');

  socket.close();
  await server.close();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);

  console.log('');
  if (failures > 0) {
    console.log('RESULT: FAIL (' + failures + ')');
    process.exit(1);
  }
  console.log('RESULT: OK — WS page lifecycle, status and reset verified');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
