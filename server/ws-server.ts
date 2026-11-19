/// <reference lib="es2022" />
/**
 * Local WebSocket ingestion server.
 *
 * Stage 1 contract:
 *  - SYNC_START only upserts file_meta; it never deletes data.
 *  - PAGE_START opens a page; CHUNK_NODES lands in nodes_staging and is ACKed.
 *  - PAGE_COMPLETE swaps the page into nodes in one transaction (no ghosts).
 *  - RESET_DATABASE(confirm:true) is the only destructive path.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { AstGraphDB } from './db';
import type {
  ComponentRow,
  FileMetaPayload,
  NodeRow,
  PageCensusRow,
  PageCompletePayload,
  PageStartPayload,
  VariableRow,
  WsMessage,
} from '../shared/protocol';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const WS_OPEN = 1;
const HEARTBEAT_MS = 30000;

export interface IngestServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  quiet?: boolean;
}

export interface RunningIngestServer {
  wss: WebSocketServer;
  db: AstGraphDB;
  host: string;
  port: number;
  close(): Promise<void>;
}

interface AckOk {
  status: 'OK';
  receivedType: WsMessage['type'];
  count: number;
  committed?: number;
  pages?: unknown[];
}

interface AckError {
  status: 'ERROR';
  receivedType: string | null;
  error: string;
}

interface SocketState {
  fileKey: string | null;
  page: { fileKey: string; pageId: string; pageName: string } | null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WS_OPEN) return;
  try {
    socket.send(JSON.stringify(value));
  } catch (error) {
    console.error('[ws] failed to send ACK: ' + describeError(error));
  }
}

function sendError(socket: WebSocket, receivedType: string | null, error: string): void {
  const ack: AckError = { status: 'ERROR', receivedType, error };
  sendJson(socket, ack);
}

export async function startIngestServer(options: IngestServerOptions = {}): Promise<RunningIngestServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const root = resolve(__dirname, '..');
  const configured = options.dbPath ?? process.env.REA_DB_PATH;
  const dbPath = configured ? resolve(root, configured) : resolve(root, 'data/rea-figma.sqlite');
  const isNewDb = !existsSync(dbPath);
  const quiet = options.quiet ?? false;

  const db = new AstGraphDB(dbPath);
  const states = new Map<WebSocket, SocketState>();
  const alive = new Map<WebSocket, boolean>();

  const wss = new WebSocketServer({ host, port, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });

  function handleRawMessage(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(socket, null, 'INVALID_JSON');
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      sendError(socket, null, 'INVALID_ENVELOPE');
      return;
    }

    const receivedType = parsed.type;
    const payload = parsed.payload;
    const state = states.get(socket) ?? { fileKey: null, page: null };
    states.set(socket, state);
    const stage = state.page ? 'page=' + state.page.pageName + ' (' + state.page.pageId + ')' : 'file=' + (state.fileKey ?? 'none');

    try {
      let count = 0;
      let committed: number | undefined;
      let pages: unknown[] | undefined;

      switch (receivedType) {
        case 'SYNC_START': {
          if (!isRecord(payload)) throw new Error('SYNC_START payload must be an object');
          const meta = payload as unknown as FileMetaPayload;
          if (!asString(meta.file_key)) throw new Error('SYNC_START payload.file_key is required');
          db.upsertFileMeta(meta);
          state.fileKey = asString(meta.file_key);
          state.page = null;
          count = 1;
          break;
        }
        case 'PAGE_START': {
          if (!isRecord(payload)) throw new Error('PAGE_START payload must be an object');
          const page = payload as unknown as PageStartPayload;
          if (!asString(page.page_id)) throw new Error('PAGE_START payload.page_id is required');
          const fileKey = asString(page.file_key) || state.fileKey || '';
          if (!fileKey) throw new Error('PAGE_START requires file_key (or a prior SYNC_START)');
          db.beginPage(fileKey, page);
          state.fileKey = fileKey;
          state.page = { fileKey, pageId: page.page_id, pageName: asString(page.page_name) };
          count = 1;
          break;
        }
        case 'CHUNK_NODES': {
          if (!Array.isArray(payload)) throw new Error('CHUNK_NODES payload must be an array');
          if (state.page) {
            count = db.stageNodes(state.page.fileKey, state.page.pageId, payload as NodeRow[]);
          } else {
            if (!state.fileKey) throw new Error('CHUNK_NODES requires PAGE_START or SYNC_START');
            count = db.insertNodesBatch(state.fileKey, payload as NodeRow[]);
          }
          break;
        }
        case 'PAGE_COMPLETE': {
          if (!isRecord(payload)) throw new Error('PAGE_COMPLETE payload must be an object');
          const done = payload as unknown as PageCompletePayload;
          if (!state.page) throw new Error('PAGE_COMPLETE without an open PAGE_START');
          if (asString(done.page_id) && asString(done.page_id) !== state.page.pageId) {
            throw new Error('PAGE_COMPLETE page_id mismatch: ' + done.page_id + ' vs ' + state.page.pageId);
          }
          const expected = typeof done.total_nodes === 'number' ? done.total_nodes : undefined;
          committed = db.completePage(state.page.fileKey, state.page.pageId, expected);
          db.checkpoint();
          state.page = null;
          count = committed;
          break;
        }
        case 'PAGE_STATUS': {
          const wanted = isRecord(payload) && typeof payload.file_key === 'string' ? payload.file_key : state.fileKey ?? undefined;
          pages = db.listPages(wanted);
          count = pages.length;
          break;
        }
        case 'PAGE_CENSUS': {
          if (!Array.isArray(payload)) throw new Error('PAGE_CENSUS payload must be an array');
          if (!state.fileKey) throw new Error('PAGE_CENSUS requires SYNC_START');
          count = db.replacePageCensus(state.fileKey, payload as PageCensusRow[]);
          break;
        }
        case 'RESET_DATABASE': {
          if (!isRecord(payload) || payload.confirm !== true) throw new Error('RESET_DATABASE requires confirm:true');
          db.resetAll();
          state.page = null;
          count = 1;
          break;
        }
        case 'CHUNK_VARIABLES': {
          if (!Array.isArray(payload)) throw new Error('CHUNK_VARIABLES payload must be an array');
          if (!state.fileKey) throw new Error('CHUNK_VARIABLES requires SYNC_START');
          count = db.insertVariablesBatch(state.fileKey, payload as VariableRow[]);
          break;
        }
        case 'CHUNK_COMPONENTS': {
          if (!Array.isArray(payload)) throw new Error('CHUNK_COMPONENTS payload must be an array');
          if (!state.fileKey) throw new Error('CHUNK_COMPONENTS requires SYNC_START');
          count = db.insertComponentsBatch(state.fileKey, payload as ComponentRow[]);
          break;
        }
        case 'SYNC_COMPLETE': {
          if (!isRecord(payload)) throw new Error('SYNC_COMPLETE payload must be an object');
          if (!state.fileKey) throw new Error('SYNC_COMPLETE requires SYNC_START');
          const totalNodes = payload.total_nodes;
          if (typeof totalNodes !== 'number' || !Number.isFinite(totalNodes)) {
            throw new Error('SYNC_COMPLETE payload.total_nodes must be a finite number');
          }
          db.finalizeSync(state.fileKey, totalNodes);
          count = 1;
          break;
        }
        default:
          sendError(socket, receivedType, 'UNKNOWN_MESSAGE_TYPE: ' + receivedType);
          return;
      }

      const ack: AckOk = { status: 'OK', receivedType: receivedType as WsMessage['type'], count };
      if (committed !== undefined) ack.committed = committed;
      if (pages !== undefined) ack.pages = pages;
      sendJson(socket, ack);

      if (!quiet) {
        if (receivedType === 'SYNC_COMPLETE') {
          const stats = db.getStats(state.fileKey ?? undefined);
          console.log('[ws] SYNC_COMPLETE — nodes=' + stats.nodes + ' variables=' + stats.variables + ' components=' + stats.components + ' file="' + (stats.file ? stats.file.file_name : 'n/a') + '"');
        } else {
          console.log('[ws] ' + receivedType + ' +' + count + ' [' + stage + ']');
        }
      }
    } catch (error) {
      sendError(socket, receivedType, describeError(error));
      if (!quiet) console.error('[ws] ' + receivedType + ' failed [' + stage + ']: ' + describeError(error));
    }
  }

  wss.on('connection', (socket, request) => {
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!quiet) console.log('[ws] client connected (' + remote + ')');
    states.set(socket, { fileKey: null, page: null });
    alive.set(socket, true);

    socket.on('pong', () => {
      alive.set(socket, true);
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        sendError(socket, null, 'BINARY_FRAMES_NOT_SUPPORTED');
        return;
      }
      handleRawMessage(socket, data.toString());
    });

    socket.on('error', (error) => {
      if (!quiet) console.error('[ws] socket error: ' + describeError(error));
    });

    socket.on('close', (code, reason) => {
      const state = states.get(socket);
      if (state?.page) {
        currentDb().abortPage(state.page.fileKey, state.page.pageId);
        if (!quiet) console.log('[ws] page aborted on disconnect: ' + state.page.pageName + ' (' + state.page.pageId + ')');
      }
      states.delete(socket);
      alive.delete(socket);
      if (!quiet) {
        const suffix = reason.length > 0 ? ' (' + reason.toString() + ')' : '';
        console.log('[ws] client disconnected code=' + code + suffix);
      }
    });
  });

  function currentDb(): AstGraphDB {
    return db;
  }

  wss.on('error', (error) => {
    if (!quiet) console.error('[ws] server error: ' + describeError(error));
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, HEARTBEAT_MS);

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const onListening = (): void => {
        wss.off('error', onStartupError);
        resolveReady();
      };
      const onStartupError = (error: Error): void => {
        wss.off('listening', onListening);
        rejectReady(error);
      };
      wss.once('listening', onListening);
      wss.once('error', onStartupError);
    });
  } catch (error) {
    clearInterval(heartbeat);
    db.close();
    try {
      wss.close();
    } catch {
      // never bound
    }
    throw error;
  }

  if (!quiet) {
    console.log('[ws] listening on ws://' + host + ':' + port);
    console.log('[ws] sqlite sink: ' + dbPath + ' (WAL, staged pages)');
    console.log('[ws] ' + (isNewDb ? 'new database will be created' : 'appending to existing database'));
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    wss.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolveClosed) => {
      wss.close(() => resolveClosed());
    });
    db.close();
  };

  return { wss, db, host, port, close };
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
        running
          .close()
          .then(() => process.exit(0))
          .catch((error) => {
            console.error('[ws] shutdown failed: ' + describeError(error));
            process.exit(1);
          });
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error) => {
      console.error('[ws] failed to start: ' + describeError(error));
      process.exitCode = 1;
    });
}
