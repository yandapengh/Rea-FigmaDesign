/// <reference lib="es2022" />
/**
 * Headless end-to-end verification for the Rea-FigmaDesign ingestion pipeline.
 *
 * Boots the real WebSocket server on port 8766 against a throwaway database,
 * streams a realistic mock export (10 variables, 5 components, 1,500 nodes),
 * waits for every durable ACK, then inspects the SQLite file directly.
 *
 * Run with: npm run test:pipeline
 * Keep artifacts for debugging: KEEP_TEST_DB=1 npm run test:pipeline
 */

import { existsSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import Database = require('better-sqlite3');
import { startIngestServer } from './ws-server';
import type { RunningIngestServer } from './ws-server';
import type {
  ComponentRow,
  FileMetaPayload,
  NodeRow,
  VariableRow,
  WsMessage,
} from '../shared/protocol';

const PORT = 8766;
const DB_FILE = resolve(process.cwd(), 'data', 'test-rea-figma.sqlite');
const NODE_COUNT = 1500;
const CHUNK_SIZE = 500;
const MAX_CTE_MS = 10;
const MAX_DB_BYTES = 2 * 1024 * 1024;
const WS_OPEN = 1;
const WS_CLOSED = 3;

const PAGE_ID = '0:0';
const PAGE_NAME = 'Page 1';
const ROOT_ID = '0:1';
const SET_ID = '100:1';

const MODE_LIGHT = '1:0';
const MODE_DARK = '1:1';

// ---------------------------------------------------------------------------
// Mock variables: primitives + semantic aliases across light/dark modes.
// ---------------------------------------------------------------------------

function variableRow(
  id: string,
  name: string,
  collectionId: string,
  collectionName: string,
  resolvedType: string,
  valuesByMode: Record<string, unknown>,
  scopes: string[],
): VariableRow {
  return {
    id,
    name,
    collection_id: collectionId,
    collection_name: collectionName,
    resolved_type: resolvedType,
    values_by_mode_json: JSON.stringify(valuesByMode),
    scopes_json: JSON.stringify(scopes),
  };
}

const PRIMITIVE_COLLECTION = 'VariableCollectionId:1:1';
const SEMANTIC_COLLECTION = 'VariableCollectionId:1:2';

const variables: VariableRow[] = [
  variableRow('VariableID:1:1', 'color/primitive/blue/500', PRIMITIVE_COLLECTION, 'Primitives', 'COLOR', {
    [MODE_LIGHT]: '#2F6BFF',
    [MODE_DARK]: '#5B8CFF',
  }, ['ALL_SCOPES']),
  variableRow('VariableID:1:2', 'color/primitive/blue/600', PRIMITIVE_COLLECTION, 'Primitives', 'COLOR', {
    [MODE_LIGHT]: '#1F4FD8',
    [MODE_DARK]: '#3F6FEA',
  }, ['ALL_SCOPES']),
  variableRow('VariableID:1:3', 'color/semantic/brand/default', SEMANTIC_COLLECTION, 'Semantic', 'COLOR', {
    [MODE_LIGHT]: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' },
    [MODE_DARK]: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' },
  }, ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL']),
  variableRow('VariableID:1:4', 'color/semantic/text/primary', SEMANTIC_COLLECTION, 'Semantic', 'COLOR', {
    [MODE_LIGHT]: '#101828',
    [MODE_DARK]: '#F2F4F7',
  }, ['TEXT_FILL']),
  variableRow('VariableID:1:5', 'color/semantic/text/muted', SEMANTIC_COLLECTION, 'Semantic', 'COLOR', {
    [MODE_LIGHT]: '#667085',
    [MODE_DARK]: '#98A2B3',
  }, ['TEXT_FILL']),
  variableRow('VariableID:1:6', 'color/semantic/surface/canvas', SEMANTIC_COLLECTION, 'Semantic', 'COLOR', {
    [MODE_LIGHT]: '#FFFFFF',
    [MODE_DARK]: '#0B0D12',
  }, ['FRAME_FILL']),
  variableRow('VariableID:1:7', 'space/primitive/4', PRIMITIVE_COLLECTION, 'Primitives', 'FLOAT', {
    [MODE_LIGHT]: 4,
    [MODE_DARK]: 4,
  }, ['GAP']),
  variableRow('VariableID:1:8', 'space/semantic/gap/sm', SEMANTIC_COLLECTION, 'Semantic', 'FLOAT', {
    [MODE_LIGHT]: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:7' },
    [MODE_DARK]: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:7' },
  }, ['GAP']),
  variableRow('VariableID:1:9', 'radius/semantic/button', SEMANTIC_COLLECTION, 'Semantic', 'FLOAT', {
    [MODE_LIGHT]: 8,
    [MODE_DARK]: 8,
  }, ['CORNER_RADIUS']),
  variableRow('VariableID:1:10', 'content/button/label', SEMANTIC_COLLECTION, 'Semantic', 'STRING', {
    [MODE_LIGHT]: 'Continue',
    [MODE_DARK]: 'Continue',
  }, ['TEXT_CONTENT']),
];

// ---------------------------------------------------------------------------
// Mock components: one Button COMPONENT_SET with four variants.
// ---------------------------------------------------------------------------

const components: ComponentRow[] = [
  {
    id: SET_ID,
    key: '8f3c1d9a2b7e4f60',
    name: 'Button',
    component_set_id: null,
    component_set_name: null,
    variant_properties_json: JSON.stringify({ Size: ['SM', 'MD'], State: ['Default', 'Hover'] }),
    description: 'Canonical Button component set.',
    page_id: PAGE_ID,
    page_name: PAGE_NAME,
  },
  ...(['SM', 'MD'] as const).flatMap((size, sizeIndex) =>
    (['Default', 'Hover'] as const).map((state, stateIndex) => {
      const index = sizeIndex * 2 + stateIndex + 1;
      return {
        id: `100:${index + 1}`,
        key: `8f3c1d9a2b7e4f6${index}`,
        name: 'Button',
        component_set_id: SET_ID,
        component_set_name: 'Button',
        variant_properties_json: JSON.stringify({ Size: size, State: state }),
        description: `Button variant ${size}/${state}.`,
        page_id: PAGE_ID,
        page_name: PAGE_NAME,
      } satisfies ComponentRow;
    }),
  ),
];

// ---------------------------------------------------------------------------
// Mock AST: 1,500 nodes over auto-layout frames, instances, text and vectors.
// ---------------------------------------------------------------------------

function layoutJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    primaryAlign: 'MIN',
    counterAlign: 'CENTER',
    sizingH: 'FILL',
    sizingV: 'HUG',
    padding: [0, 16, 0, 16],
    itemSpacing: 8,
    counterAxisSpacing: null,
    layoutWrap: 'NO_WRAP',
    ...overrides,
  });
}

function styleJson(fillHex: string, cornerRadius: number, strokeHex?: string): string {
  return JSON.stringify({
    fills: [{ type: 'SOLID', hex: fillHex, opacity: 1 }],
    strokes: strokeHex ? [{ type: 'SOLID', hex: strokeHex, opacity: 1 }] : [],
    cornerRadius,
    effects: [],
  });
}

function textStyleJson(mixed: boolean): string {
  if (mixed) {
    return JSON.stringify({
      fontFamily: 'Inter',
      fontStyle: 'MIXED',
      fontSize: 'MIXED',
      fontWeight: 500,
      lineHeight: 'MIXED',
      textAlignHorizontal: 'LEFT',
    });
  }
  return JSON.stringify({
    fontFamily: 'Inter',
    fontStyle: 'Regular',
    fontSize: 14,
    fontWeight: 400,
    lineHeight: 20,
    textAlignHorizontal: 'LEFT',
  });
}

type NodeSeed = Partial<NodeRow> & {
  id: string;
  parent_id: string | null;
  child_index: number;
  depth: number;
  type: string;
  name: string;
};

function nodeRow(seed: NodeSeed): NodeRow {
  return {
    page_id: PAGE_ID,
    page_name: PAGE_NAME,
    visible: 1,
    main_component_id: null,
    is_icon_container: 0,
    layout_mode: 'NONE',
    layout_props_json: '{}',
    bbox_x: 0,
    bbox_y: 0,
    bbox_w: 320,
    bbox_h: 200,
    style_json: '{}',
    bound_variables_json: '{}',
    text_content: null,
    text_style_json: null,
    reactions_json: null,
    ...seed,
  };
}

function buildNodes(): NodeRow[] {
  const rows: NodeRow[] = [];
  const depthById = new Map<string, number>();
  depthById.set(ROOT_ID, 0);

  rows.push(
    nodeRow({
      id: ROOT_ID,
      parent_id: null,
      child_index: 0,
      depth: 0,
      type: 'FRAME',
      name: 'REA / Product Screens',
      layout_mode: 'VERTICAL',
      layout_props_json: layoutJson({
        sizingH: 'FIXED',
        sizingV: 'FIXED',
        padding: [48, 48, 48, 48],
        itemSpacing: 32,
      }),
      bbox_w: 1440,
      bbox_h: 900,
      style_json: styleJson('#F8FAFC', 0),
    }),
  );

  const variantIds = components.slice(1).map((component) => component.id);
  const fills = ['#FFFFFF', '#F2F4F7', '#E4E7EC', '#D0D5DD', '#FEF3F2'];

  for (let i = 0; i < NODE_COUNT - 1; i += 1) {
    const id = `10:${i + 1}`;
    const parentId = i < 12 ? ROOT_ID : `10:${Math.max(1, Math.floor(i / 4))}`;
    const parentDepth = depthById.get(parentId);
    const depth = (parentDepth === undefined ? 0 : parentDepth) + 1;
    depthById.set(id, depth);

    const slot = i % 10;
    const fill = fills[i % fills.length];
    const boundVariables =
      i % 5 === 0
        ? JSON.stringify({ fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:3' }] })
        : '{}';
    const reactions =
      i % 11 === 0
        ? JSON.stringify([
            {
              trigger: 'ON_CLICK',
              action: { type: 'NODE', destinationId: ROOT_ID, navigation: 'NAVIGATE' },
            },
          ])
        : null;

    let seed: NodeSeed;

    if (slot <= 3) {
      const isIcon = i % 37 === 0;
      const layoutMode = isIcon ? 'NONE' : i % 2 === 0 ? 'VERTICAL' : 'HORIZONTAL';
      seed = {
        id,
        parent_id: parentId,
        child_index: i % 12,
        depth,
        type: 'FRAME',
        name: isIcon ? `icon/24/chevron-${i}` : `Card / ${String(i).padStart(4, '0')}`,
        is_icon_container: isIcon ? 1 : 0,
        layout_mode: layoutMode,
        layout_props_json: isIcon
          ? '{}'
          : layoutJson({
              sizingH: i % 3 === 0 ? 'FILL' : 'HUG',
              padding: [12, 16, 12, 16],
              itemSpacing: i % 2 === 0 ? 8 : 12,
            }),
        bbox_w: isIcon ? 24 : 320,
        bbox_h: isIcon ? 24 : 120 + (i % 5) * 24,
        style_json: styleJson(fill, isIcon ? 0 : 12, '#D0D5DD'),
        bound_variables_json: boundVariables,
        reactions_json: reactions,
      };
    } else if (slot === 4) {
      seed = {
        id,
        parent_id: parentId,
        child_index: i % 12,
        depth,
        type: 'INSTANCE',
        name: `Button / ${i % 2 === 0 ? 'MD' : 'SM'} / ${i % 3 === 0 ? 'Hover' : 'Default'}`,
        main_component_id: variantIds[i % variantIds.length],
        layout_mode: 'HORIZONTAL',
        layout_props_json: layoutJson({
          primaryAlign: 'CENTER',
          counterAlign: 'CENTER',
          sizingH: 'HUG',
          sizingV: 'FIXED',
          padding: [8, 16, 8, 16],
          itemSpacing: 8,
        }),
        bbox_w: i % 2 === 0 ? 148 : 112,
        bbox_h: 40,
        style_json: styleJson('#2F6BFF', 8),
        bound_variables_json: boundVariables,
        reactions_json: reactions,
      };
    } else if (slot === 5) {
      seed = {
        id,
        parent_id: parentId,
        child_index: i % 12,
        depth,
        type: 'TEXT',
        name: `Label / CTA / ${i}`,
        layout_mode: 'NONE',
        bbox_w: 96,
        bbox_h: 20,
        style_json: styleJson('#101828', 0),
        bound_variables_json: boundVariables,
        text_content: i % 3 === 0 ? 'Continue with SSO' : 'Continue',
        text_style_json: textStyleJson(i % 3 === 0),
        reactions_json: reactions,
      };
    } else if (slot === 6) {
      seed = {
        id,
        parent_id: parentId,
        child_index: i % 12,
        depth,
        type: 'VECTOR',
        name: `Vector / chevron / ${i}`,
        layout_mode: 'NONE',
        bbox_w: 16,
        bbox_h: 16,
        style_json: styleJson('#667085', 0),
      };
    } else if (slot === 7) {
      seed = {
        id,
        parent_id: parentId,
        child_index: i % 12,
        depth,
        type: 'GROUP',
        name: `Group / ${i}`,
        layout_mode: 'NONE',
        bbox_w: 240,
        bbox_h: 96,
        style_json: styleJson(fill, 4),
        bound_variables_json: boundVariables,
      };
    } else if (slot === 8) {
      seed = {
        id,
        parent_id: parentId,
        child_index: i % 12,
        depth,
        type: 'COMPONENT',
        name: `Card / Component / ${i}`,
        layout_mode: 'VERTICAL',
        layout_props_json: layoutJson({ padding: [16, 16, 16, 16], itemSpacing: 12 }),
        bbox_w: 360,
        bbox_h: 240,
        style_json: styleJson('#FFFFFF', 16),
        bound_variables_json: boundVariables,
        reactions_json: reactions,
      };
    } else {
      seed = {
        id,
        parent_id: parentId,
        child_index: i % 12,
        depth,
        type: 'RECTANGLE',
        name: `Divider / ${i}`,
        layout_mode: 'NONE',
        bbox_w: 320,
        bbox_h: 1,
        style_json: styleJson('#E4E7EC', 0),
        bound_variables_json: boundVariables,
      };
    }

    rows.push(nodeRow(seed));
  }

  return rows;
}

// ---------------------------------------------------------------------------
// WS helpers.
// ---------------------------------------------------------------------------

interface Ack {
  status: 'OK' | 'ERROR';
  receivedType?: string | null;
  count?: number;
  error?: string;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

function sendAndWait(socket: WebSocket, message: WsMessage): Promise<Ack> {
  return new Promise<Ack>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timeout waiting for ACK of ${message.type}`));
    }, 15000);

    const onMessage = (data: { toString(): string }): void => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()) as Ack);
      } catch (error) {
        reject(error);
      }
    };

    socket.once('message', onMessage);
    socket.send(JSON.stringify(message), (error) => {
      if (!error) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      reject(error);
    });
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.readyState === WS_CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 3000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close();
  });
}

// ---------------------------------------------------------------------------
// Test harness.
// ---------------------------------------------------------------------------

function removeTestDb(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_FILE + suffix;
    if (existsSync(file)) rmSync(file, { force: true });
  }
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function run(): Promise<number> {
  let failures = 0;

  const check = (condition: boolean, label: string, detail = ''): void => {
    if (condition) {
      console.log(`  \u2714 ${label}`);
    } else {
      failures += 1;
      console.error(`  \u2718 ${label}${detail ? ` — ${detail}` : ''}`);
    }
  };

  removeTestDb();

  let server: RunningIngestServer | null = null;
  let socket: WebSocket | null = null;
  let db: Database.Database | null = null;

  try {
    console.log('Rea-FigmaDesign Phase 1 — headless pipeline verification');
    console.log(`  db: ${DB_FILE}`);

    server = await startIngestServer({ port: PORT, dbPath: DB_FILE, quiet: true });
    console.log(`  ws: ws://127.0.0.1:${PORT}\n`);

    socket = new WebSocket(`ws://127.0.0.1:${PORT}`, { perMessageDeflate: false });
    socket.on('error', (error) => {
      console.error(`[test] socket error: ${error.message}`);
    });
    await waitForOpen(socket);
    check(socket.readyState === WS_OPEN, 'WebSocket relay connected');

    const nodeRows = buildNodes();
    const nodeChunks = [
      nodeRows.slice(0, CHUNK_SIZE),
      nodeRows.slice(CHUNK_SIZE, CHUNK_SIZE * 2),
      nodeRows.slice(CHUNK_SIZE * 2, CHUNK_SIZE * 3),
    ];
    check(
      nodeRows.length === NODE_COUNT && nodeChunks.every((chunk) => chunk.length === CHUNK_SIZE),
      `mock AST contains ${NODE_COUNT} nodes in ${nodeChunks.length} chunks of ${CHUNK_SIZE}`,
    );

    const meta: FileMetaPayload = {
      file_key: 'MOCK_FILE_9f2c7a',
      file_name: 'REA Design System — Mock',
      extracted_at: new Date().toISOString(),
      page_count: 3,
    };

    const packets: { message: WsMessage; expected: number; label: string }[] = [
      { message: { type: 'SYNC_START', payload: meta }, expected: 1, label: 'SYNC_START' },
      { message: { type: 'CHUNK_VARIABLES', payload: variables }, expected: variables.length, label: 'CHUNK_VARIABLES' },
      { message: { type: 'CHUNK_COMPONENTS', payload: components }, expected: components.length, label: 'CHUNK_COMPONENTS' },
      ...nodeChunks.map((payload, index) => ({
        message: { type: 'CHUNK_NODES', payload } as WsMessage,
        expected: payload.length,
        label: `CHUNK_NODES #${index + 1}`,
      })),
      {
        message: {
          type: 'SYNC_COMPLETE',
          payload: { total_nodes: nodeRows.length, duration_ms: 0 },
        },
        expected: 1,
        label: 'SYNC_COMPLETE',
      },
    ];

    const streamStartedAt = performance.now();
    for (const packet of packets) {
      const ack = await sendAndWait(socket, packet.message);
      const bytes = Buffer.byteLength(JSON.stringify(packet.message));
      check(
        ack.status === 'OK' && ack.receivedType === packet.message.type && ack.count === packet.expected,
        `${packet.label} acked (${packet.expected} rows, ${(bytes / 1024).toFixed(1)} KB)`,
        `ack=${JSON.stringify(ack)}`,
      );
    }
    const streamMs = performance.now() - streamStartedAt;
    console.log(`  streamed ${packets.length} frames in ${streamMs.toFixed(1)} ms\n`);

    await closeSocket(socket);
    socket = null;
    await server.close();
    server = null;

    db = new Database(DB_FILE);

    const scalar = (sql: string): number => {
      const row = db!.prepare(sql).get() as { c: number };
      return row.c;
    };

    const variableCount = scalar('SELECT COUNT(*) AS c FROM variables');
    const componentCount = scalar('SELECT COUNT(*) AS c FROM components');
    const nodeCount = scalar('SELECT COUNT(*) AS c FROM nodes');
    const metaRow = db
      .prepare('SELECT file_key, file_name, page_count, total_nodes FROM file_meta LIMIT 1')
      .get() as
      | { file_key: string; file_name: string; page_count: number; total_nodes: number }
      | undefined;

    check(variableCount === 10, `variables table = 10 (got ${variableCount})`);
    check(componentCount === 5, `components table = 5 (got ${componentCount})`);
    check(nodeCount === 1500, `nodes table = 1500 (got ${nodeCount})`);
    check(
      metaRow !== undefined &&
        metaRow.file_key === meta.file_key &&
        metaRow.total_nodes === nodeRows.length &&
        metaRow.page_count === meta.page_count,
      `file_meta persisted (${metaRow ? `${metaRow.file_name}, total_nodes=${metaRow.total_nodes}` : 'missing'})`,
    );

    const variantCount = scalar(
      `SELECT COUNT(*) AS c FROM components WHERE component_set_id = '${SET_ID}'`,
    );
    check(variantCount === 4, `Button variant rows linked to component set (got ${variantCount})`);

    const brandRow = db
      .prepare("SELECT values_by_mode_json FROM variables WHERE name = 'color/semantic/brand/default'")
      .get() as { values_by_mode_json: string } | undefined;
    let aliasIntact = false;
    if (brandRow) {
      const byMode = JSON.parse(brandRow.values_by_mode_json) as Record<string, { id?: string }>;
      aliasIntact =
        byMode[MODE_LIGHT] !== undefined &&
        byMode[MODE_LIGHT].id === 'VariableID:1:1' &&
        byMode[MODE_DARK] !== undefined &&
        byMode[MODE_DARK].id === 'VariableID:1:2';
    }
    check(aliasIntact, 'variable alias chain preserved in values_by_mode_json');

    const iconCount = scalar('SELECT COUNT(*) AS c FROM nodes WHERE is_icon_container = 1');
    const instanceCount = scalar("SELECT COUNT(*) AS c FROM nodes WHERE type = 'INSTANCE'");
    const mixedTextCount = scalar(
      "SELECT COUNT(*) AS c FROM nodes WHERE text_style_json LIKE '%\"MIXED\"%'",
    );
    check(
      iconCount > 0 && instanceCount > 0 && mixedTextCount > 0,
      `AST diversity: icons=${iconCount}, instances=${instanceCount}, mixed-text=${mixedTextCount}`,
    );

    const cteSql = `
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM nodes WHERE parent_id IS NULL
        UNION ALL
        SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
      )
      SELECT COUNT(*) AS c FROM subtree
    `;
    const cteStmt = db.prepare(cteSql);
    for (let warmup = 0; warmup < 20; warmup += 1) cteStmt.get();

    const runs = 200;
    let totalMs = 0;
    let maxMs = 0;
    let subtreeCount = 0;
    for (let sample = 0; sample < runs; sample += 1) {
      const startedAt = performance.now();
      const row = cteStmt.get() as { c: number };
      const elapsed = performance.now() - startedAt;
      subtreeCount = row.c;
      totalMs += elapsed;
      if (elapsed > maxMs) maxMs = elapsed;
    }
    const avgMs = totalMs / runs;
    check(subtreeCount === NODE_COUNT, `recursive CTE subtree resolves ${subtreeCount} nodes`);
    check(
      maxMs < MAX_CTE_MS,
      `recursive CTE latency avg ${avgMs.toFixed(3)} ms / max ${maxMs.toFixed(3)} ms (< ${MAX_CTE_MS} ms)`,
    );

    const journalMode = db.pragma('journal_mode', { simple: true }) as string;
    check(journalMode === 'wal', `journal_mode = ${journalMode}`);

    db.close();
    db = null;

    const dbBytes = statSync(DB_FILE).size;
    check(
      dbBytes < MAX_DB_BYTES,
      `sqlite file ${(dbBytes / 1024).toFixed(1)} KB (< ${(MAX_DB_BYTES / 1024 / 1024).toFixed(0)} MB)`,
    );

    console.log('');
    if (failures === 0) {
      console.log('RESULT: PASS — pipeline, ACK durability, schema and query budget verified.');
    } else {
      console.error(`RESULT: FAIL — ${failures} assertion(s) failed.`);
    }
    return failures;
  } finally {
    if (db && db.open) db.close();
    if (socket) socket.terminate();
    if (server) await server.close();
  }
}

run()
  .then((failures) => {
    if (!process.env.KEEP_TEST_DB) removeTestDb();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error(`\nRESULT: CRASH — ${summarize(error)}`);
    if (!process.env.KEEP_TEST_DB) removeTestDb();
    process.exit(1);
  });
