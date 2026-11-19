/// <reference lib="es2022" />
/**
 * Local ingestion server (stage 2, design A):
 *  - one folder per Figma file: data/<safeKey>/graph.sqlite + manifest.json + batches/
 *  - SYNC_START only upserts metadata; PAGE_START stages; PAGE_COMPLETE swaps atomically
 *  - empty pages arrive as PAGE_SKIP and are recorded as SKIPPED
 *  - RESET_DATABASE(confirm:true) is the only destructive path
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { AstGraphDB } from './db';
import type {
  ComponentRow, FileMetaPayload, NodeRow, PageCensusRow, PageCompletePayload, PageSkipPayload,
  PageStartPayload, PageStatusRow, VariableRow, WsMessage,
} from '../shared/protocol';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const WS_OPEN = 1;
const HEARTBEAT_MS = 30000;

export interface IngestServerOptions { host?: string; port?: number; dbPath?: string; quiet?: boolean }

export interface RunningIngestServer {
  wss: WebSocketServer;
  db: AstGraphDB | null;
  host: string;
  port: number;
  close(): Promise<void>;
}

interface AckOk { status: 'OK'; receivedType: WsMessage['type']; count: number; committed?: number; pages?: unknown[]; batchId?: number; pageId?: string; latestBatch?: unknown }
interface AckError { status: 'ERROR'; receivedType: string | null; error: string; batchId?: number }
interface BatchRecord { batch_id: number; file_key: string; started_at: string; finished_at: string | null; requested: Array<{ page_id: string; page_name: string; page_index: number }>; pages: Record<string, string> }
interface SocketState {
  fileKey: string | null;
  page: { fileKey: string; pageId: string; pageName: string; pageIndex: number } | null;
  db: AstGraphDB | null;
  folder: string | null;
  batch: BatchRecord | null;
  batchId: number | null;
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function asString(value: unknown): string { return typeof value === 'string' ? value : ''; }
function finiteNumber(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function nowIso(): string { return new Date().toISOString(); }

function safeFolder(fileKey: string, fileName: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(fileKey)) return fileKey;
  return 'file-' + createHash('sha1').update(fileKey + '|' + fileName).digest('hex').slice(0, 10);
}

function atomicJson(path: string, value: unknown): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WS_OPEN) return;
  try { socket.send(JSON.stringify(value)); } catch (error) { console.error('[ws] ack send failed: ' + describeError(error)); }
}
function sendError(socket: WebSocket, receivedType: string | null, error: string, batchId?: number): void {
  const ack: AckError = { status: 'ERROR', receivedType, error };
  if (typeof batchId === 'number') ack.batchId = batchId;
  sendJson(socket, ack);
}

export async function startIngestServer(options: IngestServerOptions = {}): Promise<RunningIngestServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const root = resolve(__dirname, '..');
  const dataRoot = join(root, 'data');
  const configured = options.dbPath ?? process.env.REA_DB_PATH;
  const fixedDb = configured ? new AstGraphDB(resolve(root, configured)) : null;
  const quiet = options.quiet ?? false;
  const openDbs = new Map<string, AstGraphDB>();
  const states = new Map<WebSocket, SocketState>();
  const alive = new Map<WebSocket, boolean>();

  function dbFor(fileKey: string, fileName: string, state: SocketState): AstGraphDB {
    if (fixedDb) { state.folder = null; return fixedDb; }
    let folder = join(dataRoot, safeFolder(fileKey, fileName));
    {
      try {
        for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const manifestPath = join(dataRoot, entry.name, 'manifest.json');
          if (!existsSync(manifestPath)) continue;
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { file_key?: string };
          if (manifest.file_key === fileKey) { folder = join(dataRoot, entry.name); break; }
        }
      } catch { /* fall back to the hashed folder */ }
    }
    state.folder = folder;
    const existing = openDbs.get(folder);
    if (existing) return existing;
    mkdirSync(join(folder, 'batches'), { recursive: true });
    const db = new AstGraphDB(join(folder, 'graph.sqlite'));
    openDbs.set(folder, db);
    return db;
  }

  function updateManifest(state: SocketState, page: { page_id: string; page_name: string; page_index: number }, status: string, nodeCount?: number): void {
    if (!state.folder) return;
    const path = join(state.folder, 'manifest.json');
    let manifest: Record<string, unknown> = { file_key: state.fileKey, updated_at: nowIso(), pages: [] };
    try { manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { /* first write */ }
    const pages = Array.isArray(manifest.pages) ? (manifest.pages as Array<Record<string, unknown>>) : [];
    const next = pages.filter((p) => p.page_id !== page.page_id);
    next.push({ page_id: page.page_id, page_name: page.page_name, page_index: page.page_index, status, node_count: nodeCount ?? 0, updated_at: nowIso() });
    next.sort((a, b) => Number(a.page_index) - Number(b.page_index));
    manifest.pages = next;
    manifest.updated_at = nowIso();
    atomicJson(path, manifest);
  }

  function beginBatch(state: SocketState, requested: Array<{ page_id: string; page_name: string; page_index: number }>): void {
    if (!state.folder) return;
    const dir = join(state.folder, 'batches');
    mkdirSync(dir, { recursive: true });
    const next = readdirSync(dir).filter((f) => f.endsWith('.json')).length + 1;
    const record: BatchRecord = { batch_id: next, file_key: state.fileKey ?? '', started_at: nowIso(), finished_at: null, requested, pages: {} };
    state.batch = record;
    atomicJson(join(dir, String(next).padStart(3, '0') + '_batch.json'), record);
  }

  function saveBatch(state: SocketState): void {
    if (!state.folder || !state.batch) return;
    atomicJson(join(state.folder, 'batches', String(state.batch.batch_id).padStart(3, '0') + '_batch.json'), state.batch);
  }

  function handleRawMessage(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { sendError(socket, null, 'INVALID_JSON'); return; }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') { sendError(socket, null, 'INVALID_ENVELOPE'); return; }

    const receivedType = parsed.type;
    const payload = parsed.payload;
    const batchId = typeof parsed.batch_id === 'number' ? parsed.batch_id : undefined;
    let state = states.get(socket);
    if (!state) { state = { fileKey: null, page: null, db: null, folder: null, batch: null, batchId: null }; states.set(socket, state); }
    const stage = state.page ? 'page=' + state.page.pageName + ' (' + state.page.pageId + ')' : 'file=' + (state.fileKey ?? 'none');

    try {
      let count = 0;
      let committed: number | undefined;
      let pages: unknown[] | undefined;
      let pageId: string | undefined;

      switch (receivedType) {
        case 'SYNC_START': {
          if (!isRecord(payload)) throw new Error('SYNC_START payload must be an object');
          const meta = payload as unknown as FileMetaPayload;
          if (!asString(meta.file_key)) throw new Error('SYNC_START payload.file_key is required');
          state.fileKey = asString(meta.file_key);
          state.page = null;
          state.db = dbFor(state.fileKey, asString(meta.file_name), state);
          state.db.upsertFileMeta(meta);
          const requested = Array.isArray(meta.pages) ? meta.pages : [];
          state.batchId = state.db.beginBatch(state.fileKey, requested.map((p) => ({ page_id: String(p.page_id), page_name: String(p.page_name) })));
          if (state.folder) {
            const manifestPath = join(state.folder, 'manifest.json');
            let manifest: Record<string, unknown> = { file_key: meta.file_key, file_name: meta.file_name, created_at: nowIso(), updated_at: nowIso(), pages: [] };
            try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>; } catch { /* first write */ }
            manifest.file_key = meta.file_key;
            manifest.file_name = meta.file_name;
            manifest.updated_at = nowIso();
            atomicJson(manifestPath, manifest);
          }
          count = 1;
          break;
        }
        case 'PAGE_START': {
          if (!state.db) throw new Error('PAGE_START requires SYNC_START');
          if (!isRecord(payload)) throw new Error('PAGE_START payload must be an object');
          const page = payload as unknown as PageStartPayload;
          if (!asString(page.page_id)) throw new Error('PAGE_START payload.page_id is required');
          const fileKey = asString(page.file_key) || state.fileKey || '';
          state.db.beginPage(fileKey, page);
          state.page = { fileKey, pageId: page.page_id, pageName: asString(page.page_name), pageIndex: finiteNumber(page.page_index, 0) };
          if (state.batchId !== null) state.db.setBatchPage(state.batchId, page.page_id, page.page_name, 'SYNCING', 0);
          count = 1;
          break;
        }
        case 'PAGE_SKIP': {
          if (!state.db) throw new Error('PAGE_SKIP requires SYNC_START');
          const page = payload as unknown as PageSkipPayload;
          if (!asString(page.page_id)) throw new Error('PAGE_SKIP payload.page_id is required');
          state.db.skipPage(state.fileKey ?? '', page);
          if (state.batch) state.batch.pages[page.page_id] = 'SKIPPED';
          pageId = page.page_id;
          saveBatch(state);
          updateManifest(state, page, 'SKIPPED', 0);
          count = 1;
          break;
        }
        case 'CHUNK_NODES': {
          if (!state.db) throw new Error('CHUNK_NODES requires SYNC_START');
          if (!Array.isArray(payload)) throw new Error('CHUNK_NODES payload must be an array');
          if (state.page) count = state.db.stageNodes(state.page.fileKey, state.page.pageId, payload as NodeRow[]);
          else count = state.db.insertNodesBatch(state.fileKey ?? '', payload as NodeRow[]);
          break;
        }
        case 'PAGE_COMPLETE': {
          if (!state.db) throw new Error('PAGE_COMPLETE requires SYNC_START');
          if (!state.page) throw new Error('PAGE_COMPLETE without an open PAGE_START');
          const done = payload as unknown as PageCompletePayload;
          if (asString(done.page_id) && asString(done.page_id) !== state.page.pageId) throw new Error('PAGE_COMPLETE page_id mismatch');
          const expected = typeof done.total_nodes === 'number' ? done.total_nodes : undefined;
          committed = state.db.completePage(state.page.fileKey, state.page.pageId, expected);
          pageId = state.page.pageId;
          state.db.checkpoint();
          if (state.batchId !== null) state.db.setBatchPage(state.batchId, state.page.pageId, state.page.pageName, 'DONE', committed);
          updateManifest(state, { page_id: state.page.pageId, page_name: state.page.pageName, page_index: state.page.pageIndex }, 'DONE', committed);
          state.page = null;
          count = committed;
          break;
        }
        case 'PAGE_STATUS': {
          const wantedKey = isRecord(payload) && typeof payload.file_key === 'string' ? payload.file_key : state.fileKey;
          if (!state.db) {
            if (!wantedKey) throw new Error('PAGE_STATUS requires file_key');
            state.fileKey = wantedKey;
            state.db = dbFor(wantedKey, '', state);
          }
          const wanted = isRecord(payload) && typeof payload.file_key === 'string' ? payload.file_key : state.fileKey ?? undefined;
          pages = state.db.listPages(wanted);
          count = pages.length;
          break;
        }
        case 'PAGE_CENSUS': {
          if (!state.db) throw new Error('PAGE_CENSUS requires SYNC_START');
          if (!Array.isArray(payload)) throw new Error('PAGE_CENSUS payload must be an array');
          count = state.db.replacePageCensus(state.fileKey ?? '', payload as PageCensusRow[]);
          break;
        }
        case 'RESET_DATABASE': {
          if (!isRecord(payload) || payload.confirm !== true) throw new Error('RESET_DATABASE requires confirm:true');
          if (fixedDb) fixedDb.resetAll();
          for (const db of openDbs.values()) db.resetAll();
          state.db?.resetAll();
          state.page = null;
          count = 1;
          break;
        }
        case 'CHUNK_VARIABLES': {
          if (!state.db) throw new Error('CHUNK_VARIABLES requires SYNC_START');
          if (!Array.isArray(payload)) throw new Error('CHUNK_VARIABLES payload must be an array');
          count = state.db.insertVariablesBatch(state.fileKey ?? '', payload as VariableRow[]);
          break;
        }
        case 'CHUNK_COMPONENTS': {
          if (!state.db) throw new Error('CHUNK_COMPONENTS requires SYNC_START');
          if (!Array.isArray(payload)) throw new Error('CHUNK_COMPONENTS payload must be an array');
          count = state.db.insertComponentsBatch(state.fileKey ?? '', payload as ComponentRow[]);
          break;
        }
        case 'SYNC_COMPLETE': {
          if (!state.db) throw new Error('SYNC_COMPLETE requires SYNC_START');
          if (!isRecord(payload)) throw new Error('SYNC_COMPLETE payload must be an object');
          const totalNodes = payload.total_nodes;
          if (typeof totalNodes !== 'number' || !Number.isFinite(totalNodes)) throw new Error('SYNC_COMPLETE total_nodes must be finite');
          state.db.finalizeSync(state.fileKey ?? '', totalNodes);
          if (state.batchId !== null) state.db.finishBatch(state.batchId, 'DONE');
          count = 1;
          break;
        }
        default:
          sendError(socket, receivedType, 'UNKNOWN_MESSAGE_TYPE: ' + receivedType, batchId);
          return;
      }

      const ack: AckOk = { status: 'OK', receivedType: receivedType as WsMessage['type'], count };
      if (committed !== undefined) ack.committed = committed;
      if (pages !== undefined) ack.pages = pages;
      if (pages !== undefined && state.db && state.fileKey) ack.latestBatch = state.db.latestBatch(state.fileKey);
      if (pageId !== undefined) ack.pageId = pageId;
      if (batchId !== undefined) ack.batchId = batchId;
      sendJson(socket, ack);
      if (!quiet) {
        if (receivedType === 'SYNC_COMPLETE') {
          const stats = state.db ? state.db.getStats(state.fileKey ?? undefined) : null;
          console.log('[ws] SYNC_COMPLETE — nodes=' + (stats ? stats.nodes : 0) + ' file="' + (stats && stats.file ? stats.file.file_name : 'n/a') + '"');
        } else console.log('[ws] ' + receivedType + ' +' + count + ' [' + stage + ']');
      }
    } catch (error) {
      sendError(socket, receivedType, describeError(error), batchId);
      if (!quiet) console.error('[ws] ' + receivedType + ' failed [' + stage + ']: ' + describeError(error));
    }
  }

  const wss = new WebSocketServer({ host, port, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });

  wss.on('connection', (socket, request) => {
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!quiet) console.log('[ws] client connected (' + remote + ')');
    states.set(socket, { fileKey: null, page: null, db: null, folder: null, batch: null, batchId: null });
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('message', (data, isBinary) => {
      if (isBinary) { sendError(socket, null, 'BINARY_FRAMES_NOT_SUPPORTED'); return; }
      handleRawMessage(socket, data.toString());
    });
    socket.on('error', (error) => { if (!quiet) console.error('[ws] socket error: ' + describeError(error)); });
    socket.on('close', (code, reason) => {
      const state = states.get(socket);
      if (state?.page && state.db) {
        state.db.abortPage(state.page.fileKey, state.page.pageId);
        if (state.batchId !== null) { state.db.setBatchPage(state.batchId, state.page.pageId, state.page.pageName, 'INCOMPLETE', 0); state.db.finishBatch(state.batchId, 'PARTIAL'); }
        if (!quiet) console.log('[ws] page aborted on disconnect: ' + state.page.pageName);
      }
      states.delete(socket);
      alive.delete(socket);
      if (!quiet) console.log('[ws] client disconnected code=' + code + (reason.length ? ' (' + reason.toString() + ')' : ''));
    });
  });

  wss.on('error', (error) => { if (!quiet) console.error('[ws] server error: ' + describeError(error)); });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) { socket.terminate(); continue; }
      alive.set(socket, false);
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }, HEARTBEAT_MS);

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const onListening = (): void => { wss.off('error', onStartupError); resolveReady(); };
      const onStartupError = (error: Error): void => { wss.off('listening', onListening); rejectReady(error); };
      wss.once('listening', onListening);
      wss.once('error', onStartupError);
    });
  } catch (error) {
    clearInterval(heartbeat);
    fixedDb?.close();
    for (const db of openDbs.values()) db.close();
    try { wss.close(); } catch { /* never bound */ }
    throw error;
  }

  if (!quiet) {
    console.log('[ws] listening on ws://' + host + ':' + port);
    console.log('[ws] sqlite sink: ' + (fixedDb ? 'fixed' : join(dataRoot, '<file-key>/graph.sqlite')));
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    wss.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolveClosed) => { wss.close(() => resolveClosed()); });
    fixedDb?.close();
    for (const db of openDbs.values()) db.close();
  };

  return { wss, db: fixedDb, host, port, close };
}

function isDirectInvocation(): boolean {
  return typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
}

if (isDirectInvocation()) {
  startIngestServer()
    .then((running) => {
      let shuttingDown = false;
      const shutdown = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('[ws] ' + signal + ' received, flushing WAL and shutting down');
        running.close().then(() => process.exit(0)).catch((error) => { console.error('[ws] shutdown failed: ' + describeError(error)); process.exit(1); });
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error) => { console.error('[ws] failed to start: ' + describeError(error)); process.exitCode = 1; });
}
