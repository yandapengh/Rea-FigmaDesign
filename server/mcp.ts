/// <reference lib="es2022" />
/**
 * MCP adapter (stdio, JSON-RPC 2.0, no SDK dependency).
 *
 * It imports the pure core directly — no CLI spawning, no shell, no formatting layer.
 * Read tools are safe; apply_labels requires confirm:true and says so in its description.
 *
 * Run: npm run mcp
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Graph, profileOf } from './core/graph';
import { buildSheetCard, diffScreens, findSimilar } from './core/analyze';
import { deriveFamilyAxes, groupStats, classifyWith, decideLabel, loadLabels, type LabelEntry, type ScreenLabel } from './core/semantics';

const ROOT = resolve(__dirname, '..');
const SAMPLES = resolve(ROOT, 'data/samples');
const LIVE_DB = resolve(ROOT, 'data/rea-figma.sqlite');
const LABELS = resolve(ROOT, 'labels');
const SCRATCH = resolve(ROOT, '.scratch');

const graphs = new Map<string, Graph>();

const CALL_LOG = resolve(ROOT, '.scratch/mcp-calls.jsonl');
const STARTED_AT = new Date().toISOString();
let callCount = 0;

function logCall(tool: string, args: Record<string, unknown>, ms: number, ok: boolean): void {
  callCount += 1;
  try {
    const summary: Record<string, unknown> = {};
    for (const k of ['id', 'a', 'b', 'page', 'sample', 'archetype']) if (args[k] !== undefined) summary[k] = args[k];
    appendFileSync(CALL_LOG, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, tool, args: summary, ms, ok }) + '\n', 'utf8');
  } catch {
    // logging must never break a call
  }
}

function samplePath(sample?: string): string {
  if (!sample || sample === 'live') {
    if (!existsSync(LIVE_DB)) throw new Error('live db not found: run the Figma extraction first');
    return LIVE_DB;
  }
  const name = sample.endsWith('.sqlite') ? sample : sample + '.sqlite';
  const path = resolve(SAMPLES, name);
  if (!existsSync(path)) throw new Error('sample not found: ' + sample + ' (call list_samples)');
  return path;
}

function graphFor(sample?: string): Graph {
  const path = samplePath(sample);
  const cached = graphs.get(path);
  if (cached) return cached;
  const g = new Graph(path);
  graphs.set(path, g);
  return g;
}

function labelsFile(): LabelEntry[] {
  try {
    return loadLabels(resolve(LABELS, 'style.json')).labels;
  } catch {
    return [];
  }
}

function screensFile(): { screens: ScreenLabel[]; taxonomy?: Record<string, string[]> } {
  return JSON.parse(readFileSync(resolve(LABELS, 'screens.json'), 'utf8')) as { screens: ScreenLabel[]; taxonomy?: Record<string, string[]> };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function ok(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }, null, 2) }] };
}

function err(code: string, message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message } }, null, 2) }], isError: true };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'server_info',
    description: 'Prove the MCP connection is live: returns pid, start time, uptime, call count and log path.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({
      server: 'rea-figma',
      version: '1.0.0',
      pid: process.pid,
      startedAt: STARTED_AT,
      uptimeSeconds: Math.round((Date.now() - Date.parse(STARTED_AT)) / 1000),
      calls: callCount,
      callLog: CALL_LOG,
    }),
  },
  {
    name: 'list_samples',
    description: 'List the live database and every frozen sample available to the other tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const out: Array<{ name: string; nodes: number; file: string }> = [];
      if (existsSync(LIVE_DB)) {
        const g = graphFor('live');
        out.push({ name: 'live', nodes: g.nodes.size, file: LIVE_DB });
      }
      if (existsSync(SAMPLES)) {
        for (const f of readdirSync(SAMPLES).filter((x) => x.endsWith('.sqlite')).sort()) {
          const g = graphFor(f);
          out.push({ name: f.replace(/\.sqlite$/, ''), nodes: g.nodes.size, file: resolve(SAMPLES, f) });
        }
      }
      return { samples: out };
    },
  },
  {
    name: 'screen_sheet',
    description: 'Feature card for one screen: structure hash, style fingerprint, copy, variant axis, generation label, and the list of things the AST cannot judge.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Figma node id, e.g. 33:27783' }, sample: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (a) => buildSheetCard(graphFor(a.sample as string), samplePath(a.sample as string), String(a.id), { labels: labelsFile() }),
  },
  {
    name: 'screen_family',
    description: 'Exact structural family (Merkle hash over type + ordered children) for a node: every member is structurally identical.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, sample: { type: 'string' }, minNodes: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (a) => {
      const g = graphFor(a.sample as string);
      const id = String(a.id);
      if (!g.nodes.has(id)) throw new Error('node not found: ' + id);
      const minNodes = typeof a.minNodes === 'number' ? a.minNodes : 0;
      const members = g.topLevelMembers(g.hash.get(id)!).filter((m) => g.subtree(m).length >= minNodes);
      return {
        hash: g.hash.get(id)!.slice(0, 12),
        members: members.map((m) => ({ id: m, name: g.nodes.get(m)!.name, page: g.nodes.get(m)!.page_name, nodes: g.subtree(m).length })),
      };
    },
  },
  {
    name: 'screen_variants',
    description: 'Vocabulary-free variant axes for a node family: which component switches between members, and the copy that differs. No semantic naming is inferred.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, sample: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (a) => {
      const g = graphFor(a.sample as string);
      const id = String(a.id);
      if (!g.nodes.has(id)) throw new Error('node not found: ' + id);
      const members = g.topLevelMembers(g.hash.get(id)!).filter((m) => g.subtree(m).length >= 120);
      if (members.length < 2) throw new Error('no sibling variants (family size ' + members.length + ')');
      const fam = deriveFamilyAxes(g, members, false);
      return fam;
    },
  },
  {
    name: 'style_profile',
    description: 'Quantified style fingerprint (palette, type, radii, effects, token adoption) for a node or a whole page.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, page: { type: 'string' }, sample: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (a) => {
      const g = graphFor(a.sample as string);
      if (a.page) {
        const page = String(a.page);
        const ids: string[] = [];
        for (const [id, n] of g.nodes) if (n.page_name === page) ids.push(id);
        if (ids.length === 0) throw new Error('page not found: ' + page);
        const p = profileOf(g, samplePath(a.sample as string), ids);
        return { target: 'page:' + page, nodes: p.nodes, palette: [...p.palette.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30), fonts: [...p.fonts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20), tokens: p.tokens };
      }
      const id = String(a.id ?? '');
      if (!g.nodes.has(id)) throw new Error('node not found: ' + id);
      const card = buildSheetCard(g, samplePath(a.sample as string), id, { labels: labelsFile() });
      return { target: id, style: card.style, structure: card.structure, copy: card.copy };
    },
  },
  {
    name: 'diff_screens',
    description: 'Structure + style delta between two screens: isomorphism, type cosine, copy/icon/palette/radius/font overlap, token adoption.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' }, sample: { type: 'string' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    handler: (a) => diffScreens(graphFor(a.sample as string), samplePath(a.sample as string), String(a.a), String(a.b)),
  },
  {
    name: 'find_similar',
    description: 'Layered recall: exact structure (Merkle hash), near structure (type cosine >= 0.9), style-only (palette/font/radius >= 0.45).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, limit: { type: 'number' }, sample: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (a) => findSimilar(graphFor(a.sample as string), samplePath(a.sample as string), String(a.id), typeof a.limit === 'number' ? a.limit : 8),
  },
  {
    name: 'review_queue',
    description: 'Pending category decisions from the last propagate run, optionally filtered by layout archetype (page / overlay-panel / overlay).',
    inputSchema: {
      type: 'object',
      properties: { archetype: { type: 'string' }, limit: { type: 'number' } },
      additionalProperties: false,
    },
    handler: (a) => {
      const path = resolve(SCRATCH, 'predictions.jsonl');
      if (!existsSync(path)) throw new Error('no predictions yet: run sync first');
      const rows = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
      const filtered = a.archetype ? rows.filter((r) => String(r.archetype) === a.archetype) : rows;
      const limit = typeof a.limit === 'number' ? a.limit : 20;
      filtered.sort((x, y) => Number(x.confidence) - Number(y.confidence));
      return { total: rows.length, filtered: filtered.length, items: filtered.slice(0, limit) };
    },
  },
  {
    name: 'apply_labels',
    description: 'MUTATING: write category/note decisions into labels/screens.json. Requires confirm:true. Use dryRun:true to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, category: { type: 'string' }, note: { type: 'string' } },
            required: ['id'],
          },
        },
        dryRun: { type: 'boolean' },
        confirm: { type: 'boolean', description: 'must be true to write' },
      },
      required: ['rows'],
      additionalProperties: false,
    },
    handler: (a) => {
      if (a.confirm !== true && a.dryRun !== true) throw new Error('apply_labels is mutating: pass confirm:true (or dryRun:true)');
      const doc = screensFile();
      const byId = new Map(doc.screens.map((s) => [s.id, s]));
      const updates: Array<Record<string, unknown>> = [];
      for (const raw of (a.rows as Array<Record<string, unknown>>) ?? []) {
        const id = String(raw.id ?? '');
        if (!id) continue;
        let entry = byId.get(id);
        if (!entry) {
          entry = { id, category: String(raw.category ?? '未分類'), kind: /彈窗|dialog|popup|modal/i.test(String(raw.category ?? '')) ? 'dialog' : 'page' };
          doc.screens.push(entry);
          byId.set(id, entry);
          updates.push({ id, added: true, category: entry.category, note: raw.note ?? null });
          continue;
        }
        const before = entry.category;
        if (typeof raw.category === 'string' && raw.category) {
          entry.category = raw.category;
          entry.kind = /彈窗|dialog|popup|modal/i.test(raw.category) ? 'dialog' : 'page';
        }
        if (typeof raw.note === 'string' && raw.note) entry.note = raw.note;
        updates.push({ id, before, after: entry.category, note: entry.note ?? null });
      }
      if (a.dryRun === true) return { dryRun: true, updates };
      writeFileSync(resolve(LABELS, 'screens.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
      return { dryRun: false, written: resolve(LABELS, 'screens.json'), updates };
    },
  },
];

function handlerFor(name: string): ToolDef | undefined {
  return TOOL_DEFS.filter((t) => t.name === name)[0];
}

const toolsList = {
  tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
};

function respond(id: unknown, payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
}

function handle(msg: Record<string, unknown>): void {
  const id = msg.id;
  const method = String(msg.method ?? '');
  const params = (msg.params ?? {}) as Record<string, unknown>;
  try {
    if (method === 'initialize') {
      respond(id, {
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'rea-figma', version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') {
      respond(id, { result: {} });
      return;
    }
    if (method === 'tools/list') {
      respond(id, { result: toolsList });
      return;
    }
    if (method === 'tools/call') {
      const name = String(params.name ?? '');
      const def = handlerFor(name);
      if (!def) {
        respond(id, { error: { code: -32602, message: 'unknown tool: ' + name } });
        return;
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const t0 = Date.now();
      try {
        const result = def.handler(args);
        logCall(name, args, Date.now() - t0, true);
        respond(id, { result: ok(result) });
      } catch (e) {
        logCall(name, args, Date.now() - t0, false);
        respond(id, { result: err('tool_error', e instanceof Error ? e.message : String(e)) });
      }
      return;
    }
    respond(id, { error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) {
    respond(id, { error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    process.stderr.write('rea-figma mcp: bad json line\n');
    return;
  }
  handle(msg);
});
process.stderr.write('rea-figma mcp: ready on stdio\n');
