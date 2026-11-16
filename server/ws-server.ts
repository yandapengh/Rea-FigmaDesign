/// <reference lib="es2022" />
/**
 * Local WebSocket ingestion server.
 *
 * The Figma iframe relay connects to ws://127.0.0.1:8765 and streams
 * SYNC_START -> CHUNK_* -> SYNC_COMPLETE. Every chunk is committed to SQLite
 * before its ACK is sent, so the plugin can treat ACK as "durable".
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
  VariableRow,
  WsMessage,
} from '../shared/protocol';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per WS frame
const WS_OPEN = 1;

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
}

interface AckError {
  status: 'ERROR';
  receivedType: string | null;
  error: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WS_OPEN) return;
  try {
    socket.send(JSON.stringify(value));
  } catch (error) {
    console.error(`[ws] failed to send ACK: ${describeError(error)}`);
  }
}

function sendError(socket: WebSocket, receivedType: string | null, error: string): void {
  const ack: AckError = { status: 'ERROR', receivedType, error };
  sendJson(socket, ack);
}

function handleRawMessage(
  socket: WebSocket,
  raw: string,
  db: AstGraphDB,
  quiet: boolean,
): void {
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

  try {
    let count: number;
    switch (receivedType) {
      case 'SYNC_START': {
        if (!isRecord(payload)) throw new Error('SYNC_START payload must be an object');
        const meta = payload as unknown as FileMetaPayload;
        db.resetAndInitFile(meta);
        count = 1;
        break;
      }
      case 'CHUNK_VARIABLES': {
        if (!Array.isArray(payload)) throw new Error('CHUNK_VARIABLES payload must be an array');
        count = db.insertVariablesBatch(payload as VariableRow[]);
        break;
      }
      case 'CHUNK_COMPONENTS': {
        if (!Array.isArray(payload)) throw new Error('CHUNK_COMPONENTS payload must be an array');
        count = db.insertComponentsBatch(payload as ComponentRow[]);
        break;
      }
      case 'CHUNK_NODES': {
        if (!Array.isArray(payload)) throw new Error('CHUNK_NODES payload must be an array');
        count = db.insertNodesBatch(payload as NodeRow[]);
        break;
      }
      case 'PAGE_CENSUS': {
        if (!Array.isArray(payload)) throw new Error('PAGE_CENSUS payload must be an array');
        count = db.replacePageCensus(payload as PageCensusRow[]);
        break;
      }
      case 'SYNC_COMPLETE': {
        if (!isRecord(payload)) throw new Error('SYNC_COMPLETE payload must be an object');
        const totalNodes = payload.total_nodes;
        if (typeof totalNodes !== 'number' || !Number.isFinite(totalNodes)) {
          throw new Error('SYNC_COMPLETE payload.total_nodes must be a finite number');
        }
        db.finalizeSync(totalNodes);
        count = 1;
        break;
      }
      default:
        sendError(socket, receivedType, `UNKNOWN_MESSAGE_TYPE: ${receivedType}`);
        return;
    }

    const ack: AckOk = {
      status: 'OK',
      receivedType: receivedType as WsMessage['type'],
      count,
    };
    sendJson(socket, ack);

    if (!quiet) {
      if (receivedType === 'SYNC_COMPLETE') {
        const stats = db.getStats();
        console.log(
          `[ws] SYNC_COMPLETE — nodes=${stats.nodes} variables=${stats.variables} ` +
            `components=${stats.components} file="${stats.file ? stats.file.file_name : 'n/a'}"`,
        );
      } else {
        console.log(`[ws] ${receivedType} +${count}`);
      }
    }
  } catch (error) {
    sendError(socket, receivedType, describeError(error));
    if (!quiet) {
      console.error(`[ws] ${receivedType} failed: ${describeError(error)}`);
    }
  }
}

/**
 * Boots the ingestion server and resolves once it is actually listening.
 * A rejected start closes the SQLite handle so tests never leak handles.
 */
export async function startIngestServer(
  options: IngestServerOptions = {},
): Promise<RunningIngestServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  // Resolve every path from the checkout, not the caller's cwd: `npm run start:server`
  // may be launched from anywhere, and data must still land in the same sink.
  const root = resolve(__dirname, '..');
  const configured = options.dbPath ?? process.env.REA_DB_PATH;
  const dbPath = configured ? resolve(root, configured) : resolve(root, 'data/rea-figma.sqlite');
  const isNewDb = !existsSync(dbPath);
  const quiet = options.quiet ?? false;

  const db = new AstGraphDB(dbPath);
  const wss = new WebSocketServer({
    host,
    port,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  wss.on('connection', (socket, request) => {
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!quiet) console.log(`[ws] client connected (${remote})`);

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        sendError(socket, null, 'BINARY_FRAMES_NOT_SUPPORTED');
        return;
      }
      handleRawMessage(socket, data.toString(), db, quiet);
    });

    socket.on('error', (error) => {
      if (!quiet) console.error(`[ws] socket error: ${describeError(error)}`);
    });

    socket.on('close', (code, reason) => {
      if (!quiet) {
        const suffix = reason.length > 0 ? ` (${reason.toString()})` : '';
        console.log(`[ws] client disconnected code=${code}${suffix}`);
      }
    });
  });

  wss.on('error', (error) => {
    if (!quiet) console.error(`[ws] server error: ${describeError(error)}`);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        wss.off('error', onStartupError);
        resolve();
      };
      const onStartupError = (error: Error): void => {
        wss.off('listening', onListening);
        reject(error);
      };
      wss.once('listening', onListening);
      wss.once('error', onStartupError);
    });
  } catch (error) {
    db.close();
    try {
      wss.close();
    } catch {
      // The listener never bound; nothing to close.
    }
    throw error;
  }

  if (!quiet) {
    console.log(`[ws] listening on ws://${host}:${port}`);
    console.log(`[ws] sqlite sink: ${dbPath} (WAL, synchronous=NORMAL)`);
    console.log(`[ws] ${isNewDb ? 'new database will be created' : 'appending to existing database'}`);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    wss.clients.forEach((client) => {
      client.terminate();
    });
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    db.close();
  };

  return { wss, db, host, port, close };
}

/** True when this module is the process entry point (tsx server/ws-server.ts). */
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
        console.log(`[ws] ${signal} received, flushing WAL and shutting down`);
        running
          .close()
          .then(() => process.exit(0))
          .catch((error) => {
            console.error(`[ws] shutdown failed: ${describeError(error)}`);
            process.exit(1);
          });
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error) => {
      console.error(`[ws] failed to start: ${describeError(error)}`);
      process.exitCode = 1;
    });
}
