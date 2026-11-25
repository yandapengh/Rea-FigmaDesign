/// <reference lib="es2022" />
/**
 * MCP adapter (stdio, JSON-RPC 2.0, no SDK dependency).
 *
 * It imports the pure core directly — no CLI spawning, no shell, no formatting layer.
 * Read tools are safe; apply_labels requires confirm:true and says so in its description.
 *
 * Run: npm run mcp
 */

import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Graph, archetypeOf, findScreenRoots, headlineOf, profileOf, slotsOf } from './core/graph';
import { AstGraphDB } from './db';
import { buildSheetCard, diffScreens, findSimilar } from './core/analyze';
import {
  deriveFamilyAxes, loadLabels,
  tryLoadScreenLabelsV2, recomputeV2Counts, summarizeCategoriesV2, categoryReportV2,
  type LabelEntry, type ScreenLabelV2, type ScreenLabelsV2File,
} from './core/semantics';
import { runHealthChecks } from './core/health';
import { generateReviewBoard } from './review-board';

const ROOT = resolve(__dirname, '..');
const SAMPLES = resolve(ROOT, 'data/samples');
const LIVE_DB = AstGraphDB.resolveLatestGraphDb(ROOT) ?? resolve(ROOT, 'data/rea-figma.sqlite');
const LABELS = resolve(ROOT, 'labels');

const graphs = new Map<string, Graph>();

const CALL_LOG = resolve(ROOT, '.scratch/mcp-calls.jsonl');
const STARTED_AT = new Date().toISOString();
let callCount = 0;

function logCall(tool: string, args: Record<string, unknown>, ms: number, ok: boolean): void {
  callCount += 1;
  try {
    const summary: Record<string, unknown> = {};
    for (const k of ['id', 'a', 'b', 'page', 'sample', 'archetype', 'category']) if (args[k] !== undefined) summary[k] = args[k];
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

function loadV2LabelsDoc(): ScreenLabelsV2File {
  const v2Path = resolve(LABELS, 'screens-v2.json');
  return tryLoadScreenLabelsV2(v2Path) ?? {
    version: 2,
    sample: 'live',
    note: 'created via apply_labels',
    counts: {},
    screens: [],
  };
}

function loadV2LabelsMap(): Map<string, ScreenLabelV2> {
  const doc = tryLoadScreenLabelsV2(resolve(LABELS, 'screens-v2.json'));
  const map = new Map<string, ScreenLabelV2>();
  if (doc) for (const s of doc.screens) map.set(s.id, s);
  return map;
}

function pageMapFromGraph(g: Graph): Map<string, string> {
  const map = new Map<string, string>();
  for (const [id, n] of g.nodes) map.set(id, n.page_name ?? '');
  return map;
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
  annotations?: Record<string, unknown>;
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
    name: 'list_screens',
    description: 'Enumerate screens with their layout archetype, v2 taxonomy label, and count them by archetype. Default unique:true keeps one row per (structure hash + headline); unique:false returns every screen.',
    inputSchema: {
      type: 'object',
      properties: {
        archetype: { type: 'string', enum: ['page', 'overlay-panel', 'overlay', 'unknown'], description: 'optional filter' },
        sample: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 2000, description: 'max rows to return (default 500)' },
        unique: { type: 'boolean', description: 'one representative per structural family (default true)' },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const want = typeof a.archetype === 'string' ? a.archetype : '';
      const allowed = ['page', 'overlay-panel', 'overlay', 'unknown'];
      if (want && allowed.indexOf(want) === -1) throw new Error('invalid archetype: ' + want + ' (allowed: ' + allowed.join(', ') + ')');
      const g = graphFor(a.sample as string);
      const roots = findScreenRoots(g, 40);
      const unique = a.unique !== false;
      const v2Map = loadV2LabelsMap();
      const seen = new Set<string>();
      const counts: Record<string, number> = {};
      const rows: Array<Record<string, unknown>> = [];
      let labeled = 0;
      let unlabeled = 0;
      for (const id of roots) {
        const nodes = g.subtree(id).length;
        const hash = g.hash.get(id)!;
        const key = hash + '|' + headlineOf(slotsOf(g, id).texts);
        if (unique && seen.has(key)) continue;
        seen.add(key);
        const n = g.nodes.get(id)!;
        const archetype = archetypeOf(g, id);
        counts[archetype] = (counts[archetype] ?? 0) + 1;
        const v2 = v2Map.get(id);
        if (v2) labeled += 1;
        else unlabeled += 1;
        rows.push({
          id,
          name: n.name,
          page: n.page_name ?? '',
          archetype,
          nodes,
          family: hash.slice(0, 12),
          label: v2?.label ?? '',
          major: v2?.major ?? '',
          minor: v2?.minor ?? '',
          generation: v2?.generation ?? '',
        });
      }
      const filtered = want ? rows.filter((r) => r.archetype === want) : rows;
      const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(2000, a.limit)) : 500;
      return {
        total: rows.length,
        labeled,
        unlabeled,
        byArchetype: counts,
        archetype: want || 'all',
        matched: filtered.length,
        returned: Math.min(filtered.length, limit),
        screens: filtered.slice(0, limit),
      };
    },
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
      return deriveFamilyAxes(g, members, false);
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
    name: 'list_categories',
    description: 'List all major/minor categories in labels/screens-v2.json with screen counts and Figma page counts.',
    inputSchema: {
      type: 'object',
      properties: { sample: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (a) => {
      const v2Doc = tryLoadScreenLabelsV2(resolve(LABELS, 'screens-v2.json'));
      if (!v2Doc || v2Doc.screens.length === 0) return { total: 0, majors: [] };
      const g = graphFor(a.sample as string);
      const majors = summarizeCategoriesV2(v2Doc.screens, pageMapFromGraph(g));
      return { total: v2Doc.screens.length, majors };
    },
  },
  {
    name: 'category_report',
    description: 'List every Figma page and node ID belonging to one category (minor, label, or major) in labels/screens-v2.json.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Minor, label, or major category name' },
        sample: { type: 'string' },
      },
      required: ['category'],
      additionalProperties: false,
    },
    handler: (a) => {
      const category = String(a.category ?? '').trim();
      if (!category) throw new Error('category is required');
      const v2Doc = tryLoadScreenLabelsV2(resolve(LABELS, 'screens-v2.json'));
      if (!v2Doc || v2Doc.screens.length === 0) throw new Error('no v2 labels yet in labels/screens-v2.json');
      const g = graphFor(a.sample as string);
      const report = categoryReportV2(v2Doc.screens, category, pageMapFromGraph(g));
      if (!report) throw new Error('no screens found for category: ' + category);
      return report;
    },
  },
  {
    name: 'health_check',
    description: 'Run read-only SQLite graph integrity checks (file_meta, staging, syncing, orphan nodes, page/node counts).',
    inputSchema: {
      type: 'object',
      properties: { sample: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (a) => runHealthChecks(samplePath(a.sample as string), false),
  },
  {
    name: 'build_review_board',
    description: 'Generate the visual human-review workbench (.scratch/review.html) with freeform feedback inputs and Copy-as-Prompt export. Supports cold-start AST grouping (unlabeled:true), category audit, stratified sampling, or explicit IDs.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        unlabeled: { type: 'boolean' },
        sampleCount: { type: 'number', minimum: 1, maximum: 500 },
        page: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' } },
        open: { type: 'boolean' },
        sample: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const db = samplePath(a.sample as string);
      const g = graphFor(a.sample as string);
      const res = generateReviewBoard({
        dbPath: db,
        graph: g,
        category: typeof a.category === 'string' ? a.category : undefined,
        unlabeled: a.unlabeled === true,
        sample: typeof a.sampleCount === 'number' ? a.sampleCount : undefined,
        page: typeof a.page === 'string' ? a.page : undefined,
        ids: Array.isArray(a.ids) ? a.ids.map(String) : undefined,
        open: a.open === true,
      });
      return {
        html: res.html,
        unique: res.unique,
        screens: res.screens,
        modeLabel: res.modeLabel,
        isColdStart: res.isColdStart,
      };
    },
  },
  {
    name: 'apply_labels',
    description: 'MUTATING: write label/major/minor/generation/note decisions into labels/screens-v2.json. Requires confirm:true. Use dryRun:true to preview.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              major: { type: 'string' },
              minor: { type: 'string' },
              label: { type: 'string' },
              generation: { type: 'string', enum: ['', 'old', 'new'] },
              category: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['id'],
            additionalProperties: false,
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
      const v2Path = resolve(LABELS, 'screens-v2.json');
      const v2Doc = loadV2LabelsDoc();
      const g = existsSync(LIVE_DB) ? graphFor('live') : null;
      const byId = new Map(v2Doc.screens.map((s) => [s.id, s]));
      const updates: Array<Record<string, unknown>> = [];
      for (const raw of (a.rows as Array<Record<string, unknown>>) ?? []) {
        const id = String(raw.id ?? '').trim();
        if (!id) continue;
        if (g && !g.nodes.has(id)) {
          throw new Error('node id not found in live graph: ' + id);
        }
        const cat = typeof raw.category === 'string' ? raw.category.trim() : '';
        const majorIn = typeof raw.major === 'string' ? raw.major.trim() : '';
        const minorIn = typeof raw.minor === 'string' ? raw.minor.trim() : '';
        const labelIn = typeof raw.label === 'string' ? raw.label.trim() : '';
        const genIn = typeof raw.generation === 'string' ? raw.generation.trim() : undefined;
        const noteIn = typeof raw.note === 'string' ? raw.note.trim() : '';
        const inferredMajor = cat ? (/彈窗|dialog|popup|modal|toast/i.test(cat) ? '彈窗類' : '頁面類') : '';
        const nextMajor = majorIn || inferredMajor;
        const nextMinor = minorIn || cat;
        const nextLabel = labelIn || nextMinor || nextMajor;

        const existing = byId.get(id);
        if (!existing) {
          if (!nextMajor) throw new Error('new screen entry requires major (or category) for id: ' + id);
          const entry: ScreenLabelV2 = {
            id,
            label: nextLabel || nextMajor,
            major: nextMajor,
            minor: nextMinor,
            generation: genIn ?? '',
          };
          if (noteIn) entry.note = noteIn;
          v2Doc.screens.push(entry);
          byId.set(id, entry);
          updates.push({ id, added: true, after: { ...entry } });
          continue;
        }
        const before = { ...existing };
        if (nextMajor) existing.major = nextMajor;
        if (minorIn || cat) existing.minor = nextMinor;
        if (labelIn || minorIn || cat || majorIn) existing.label = labelIn || existing.minor || existing.major;
        if (genIn !== undefined) existing.generation = genIn;
        if (noteIn) existing.note = noteIn;
        updates.push({ id, before, after: { ...existing } });
      }
      v2Doc.counts = recomputeV2Counts(v2Doc.screens);
      if (a.dryRun === true) return { dryRun: true, target: 'labels/screens-v2.json', counts: v2Doc.counts, updates };
      writeFileSync(v2Path, JSON.stringify(v2Doc, null, 2) + '\n', 'utf8');
      return { dryRun: false, written: v2Path, counts: v2Doc.counts, updates };
    },
  },
];

function handlerFor(name: string): ToolDef | undefined {
  return TOOL_DEFS.filter((t) => t.name === name)[0];
}

const toolsList = {
  tools: TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations ?? { readOnlyHint: true, openWorldHint: false },
  })),
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
