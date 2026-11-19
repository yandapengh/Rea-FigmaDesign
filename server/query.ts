import { createHash } from 'node:crypto';
import { AstGraphDB } from './db';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import {
  Graph, profileOf, slotsOf, typeHist, cosine, jaccard, topEntries,
  archetypeOf, headlineOf, isChrome,
} from './core/graph';
import {
  loadLabels, groupStats, classifyWith, decideLabel, deriveFamilyAxes,
  componentsOf, loadMarkers, hasDialogMarker,
  type LabelEntry, type GroupStats, type DerivedFamily, type ScreenLabel,
} from './core/semantics';
import { buildSheetCard, diffScreens, findSimilar, type FindRow } from './core/analyze';

/// <reference lib="es2022" />
/**
 * Design feature query layer — read-only CLI over the frozen Figma AST graph.
 *
 * Boundaries (PLAN.md §6):
 *  - never writes to the database, the schema, or the plugin;
 *  - generated artifacts (reports, dumps) may only land under .scratch/;
 *  - node identity is a structural Merkle hash over (type, ordered children);
 *    layer names are a ranking prior and drift signal, never a key.
 *
 * Usage:
 *   npx tsx server/query.ts family 33:27783 [--db path] [--json]
 *   npx tsx server/query.ts profile 33:27783 [--json]
 *   npx tsx server/query.ts profile --page "NFC" [--json]
 *   npx tsx server/query.ts diff 33:27783 1:17197 [--json]
 *   npx tsx server/query.ts find --like 33:27783 --top 8 [--json]
 *
 * --out <path> writes the same payload under .scratch/ (always ignored by git).
 */

import Database = require('better-sqlite3');

// Resolve everything from the checkout, not the caller's cwd, so the CLI works from any directory.
const ROOT = resolve(__dirname, '..');
const SCRATCH = resolve(ROOT, '.scratch');
const DEFAULT_DB = AstGraphDB.resolveLatestGraphDb(ROOT) ?? resolve(ROOT, 'data/rea-figma.sqlite');
const OPT = {
  db: DEFAULT_DB,
  json: false,
  help: false,
  out: null as string | null,
  top: 8,
  page: null as string | null,
  minNodes: 0,
  labels: resolve(ROOT, 'labels/style.json'),
  hint: false,
  unique: false,
  k: 10,
  archetype: null as string | null,
  markers: resolve(ROOT, 'labels/archetype.json'),
  screenLabels: resolve(ROOT, 'labels/screens.json'),
  md: resolve(SCRATCH, 'feedback.md'),
  dryRun: false,
  groupBy: 'category',
  category: null as string | null,
  all: false,
  sample: 10,
  input: resolve(SCRATCH, 'sheets.jsonl'),
  minMembers: 3,
  floor: 0.55,
};

type ErrorCode = 'invalid_argument' | 'not_found' | 'missing_input' | 'guard_rejected' | 'internal';

class ToolError extends Error {
  readonly code: ErrorCode;
  readonly fix?: string;
  constructor(code: ErrorCode, message: string, fix?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.fix = fix;
  }
}

function fail(msg: string, code: ErrorCode = 'invalid_argument', fix?: string): never {
  throw new ToolError(code, msg, fix);
}

function parseArgs(argv: string[]): { cmd: string; positional: string[] } {
  const positional: string[] = [];
  let cmd = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') OPT.json = true;
    else if (a === '--help' || a === '-h') OPT.help = true;
    else if (a === '--db') OPT.db = resolve(ROOT, argv[++i] ?? fail('--db needs a value'));
    else if (a === '--out') OPT.out = argv[++i] ?? fail('--out needs a value');
    else if (a === '--top') OPT.top = Number(argv[++i] ?? fail('--top needs a value'));
    else if (a === '--page') OPT.page = argv[++i] ?? fail('--page needs a value');
    else if (a === '--min-nodes') OPT.minNodes = Number(argv[++i] ?? fail('--min-nodes needs a value'));
    else if (a === '--labels') OPT.labels = resolve(ROOT, argv[++i] ?? fail('--labels needs a value'));
    else if (a === '--floor') OPT.floor = Number(argv[++i] ?? fail('--floor needs a value'));
    else if (a === '--hint') OPT.hint = true;
    else if (a === '--unique') OPT.unique = true;
    else if (a === '--k') OPT.k = Number(argv[++i] ?? fail('--k needs a value'));
    else if (a === '--archetype') OPT.archetype = argv[++i] ?? fail('--archetype needs a value');
    else if (a === '--markers') OPT.markers = resolve(ROOT, argv[++i] ?? fail('--markers needs a value'));
    else if (a === '--screen-labels') OPT.screenLabels = resolve(ROOT, argv[++i] ?? fail('--screen-labels needs a value'));
    else if (a === '--md') OPT.md = resolve(ROOT, argv[++i] ?? fail('--md needs a value'));
    else if (a === '--dry-run') OPT.dryRun = true;
    else if (a === '--all') OPT.all = true;
    else if (a === '--group-by') OPT.groupBy = argv[++i] ?? fail('--group-by needs a value');
    else if (a === '--category') OPT.category = argv[++i] ?? fail('--category needs a value');
    else if (a === '--sample') OPT.sample = Number(argv[++i] ?? fail('--sample needs a value'));
    else if (a === '--in') OPT.input = resolve(ROOT, argv[++i] ?? fail('--in needs a value'));
    else if (a === '--min-members') OPT.minMembers = Number(argv[++i] ?? fail('--min-members needs a value'));
    else if (a.startsWith('--')) fail('unknown flag ' + a);
    else if (!cmd) cmd = a;
    else positional.push(a);
  }
  return { cmd, positional };
}

function emit(payload: unknown, text: string): void {
  if (OPT.json) console.log(JSON.stringify({ ok: true, data: payload }, null, 2));
  else console.log(text);
  if (OPT.out) {
    const target = resolve(ROOT, OPT.out);
    if (!(target === SCRATCH || target.startsWith(SCRATCH + sep))) {
      fail('--out must stay inside .scratch/ (got ' + target + ')');
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, OPT.json ? JSON.stringify(payload, null, 2) : text, 'utf8');
    console.error('wrote ' + target);
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function fmtMap<K>(m: Map<K, number>, n: number): string {
  return topEntries(m, n)
    .map(([k, v]) => String(k) + ':' + v)
    .join(' ');
}


interface ToolSpec {
  name: string;
  summary: string;
  args: string;
  mutates: boolean;
  writes: boolean;
}

const TOOLS: ToolSpec[] = [
  { name: 'doctor', summary: 'preflight (npm run doctor, separate entry)', args: '', mutates: false, writes: false },
  { name: 'manifest', summary: 'list this tool surface as JSON', args: '', mutates: false, writes: false },
  { name: 'sheet', summary: 'one-screen feature card', args: '<id>', mutates: false, writes: false },
  { name: 'sheets', summary: 'feature table for every screen', args: '[--unique] [--out path]', mutates: false, writes: true },
  { name: 'family', summary: 'exact structural family members', args: '<id> [--min-nodes N]', mutates: false, writes: false },
  { name: 'variants', summary: 'variant axes across families', args: '[--top N]', mutates: false, writes: true },
  { name: 'variant', summary: 'which axis one node sits on', args: '<id>', mutates: false, writes: false },
  { name: 'profile', summary: 'quantified style profile', args: '<id> | --page NAME', mutates: false, writes: false },
  { name: 'diff', summary: 'structure + style delta between two nodes', args: '<a> <b>', mutates: false, writes: false },
  { name: 'find', summary: 'layered recall: exact / near / style', args: '<id> [--top N]', mutates: false, writes: false },
  { name: 'classify', summary: 'new-vs-old generation verdict', args: '<id> [--floor F]', mutates: false, writes: false },
  { name: 'scan', summary: 'classify every screen', args: '[--top N] [--out path]', mutates: false, writes: true },
  { name: 'derive', summary: 'labelled split, separability, leave-one-out', args: '', mutates: false, writes: false },
  { name: 'cluster', summary: 'k-means over the feature table', args: '[--k N] [--archetype X]', mutates: false, writes: true },
  { name: 'markers', summary: 'learn dialog components from labels (analysis)', args: '', mutates: false, writes: true },
  { name: 'propagate', summary: 'kNN label propagation with confidence bands', args: '[--top N]', mutates: false, writes: true },
  { name: 'review', summary: 'build the visual triage board', args: '', mutates: false, writes: true },
  { name: 'apply', summary: 'write designer feedback (markdown) into labels', args: '--md <file> [--dry-run]', mutates: true, writes: true },
  { name: 'verify-source', summary: 'every id/name in labels and queues must exist in the sample', args: '', mutates: false, writes: false },
  { name: 'category', summary: 'list screens of one category, sampled above 40 pages', args: '<name> [--all] [--sample N]', mutates: false, writes: false },
];

const MODES = ['manifest', 'family', 'profile', 'diff', 'find', 'derive', 'classify', 'scan', 'variants', 'variant', 'sheet', 'sheets', 'cluster', 'markers', 'propagate', 'review', 'apply', 'verify-source', 'category'];

function helpText(): string {
  const lines: string[] = [];
  lines.push('rea-figma query layer');
  lines.push('');
  lines.push('usage: npm run query -- <command> [args] [--db path] [--json] [--out .scratch/x]');
  lines.push('       npm run query -- <command> --help   (this list)');
  lines.push('');
  lines.push(pad('command', 12) + pad('args', 34) + 'summary');
  for (const t of TOOLS) lines.push(pad(t.name, 12) + pad(t.args, 34) + t.summary);
  lines.push('');
  lines.push('paths      resolved from the checkout, not the caller cwd');
  lines.push('artifacts  --out must stay inside .scratch/');
  lines.push('labels     labels/*.json is source; only "apply" writes it');
  lines.push('');
  lines.push('apply markdown schema');
  lines.push('  | ID | 正確分類 | 備註 |     (header names matter, column order does not)');
  lines.push('  - ID must exist in the sample; unknown ids are rejected, never invented');
  lines.push('  - valid id with no label becomes "added"; an existing label becomes "updated"');
  lines.push('  - duplicate ids in one file count once (last row wins)');
  lines.push('examples   npm run query -- sheet 33:27783');
  lines.push('           npm run query -- apply --md feedback.md --dry-run');
  return lines.join('\n');
}

function main(): void {
  const { cmd, positional } = parseArgs(process.argv.slice(2));
  if (OPT.help || cmd === 'help' || cmd === '') {
    console.log(helpText());
    return;
  }
  if (MODES.indexOf(cmd) === -1) {
    fail('usage: query.ts <' + MODES.join('|') + '> [args] [--db path] [--json] [--out .scratch/x]');
  }
  if (cmd === 'manifest') {
    const lines = ['tools  ' + TOOLS.length + '  (json: --json)', ''];
    lines.push(pad('name', 12) + pad('mutates', 9) + pad('writes', 8) + 'summary');
    for (const t of TOOLS) {
      lines.push(pad(t.name, 12) + pad(t.mutates ? 'yes' : '-', 9) + pad(t.writes ? 'yes' : '-', 8) + t.summary);
    }
    emit({ command: 'manifest', tools: TOOLS }, lines.join('\n'));
    return;
  }

  const g = new Graph(OPT.db);

  if (cmd === 'family') {
    const id = positional[0] ?? fail('family needs a node id');
    if (!g.nodes.has(id)) fail('node not found: ' + id, 'not_found');
    const hash = g.hash.get(id)!;
    const members = g.topLevelMembers(hash).filter((m) => g.subtree(m).length >= OPT.minNodes);
    const variants = new Map<string, string[]>();
    const rows = members.map((m) => {
      const s = slotsOf(g, m);
      const key = createHash('md5')
        .update(s.texts.join('|') + '#' + s.icons.join(','))
        .digest('hex')
        .slice(0, 6);
      const bucket = variants.get(key);
      if (bucket) bucket.push(m);
      else variants.set(key, [m]);
      const n = g.nodes.get(m)!;
      return { id: m, page: n.page_name, name: n.name, type: n.type, nodes: s.nodes, texts: s.texts, key };
    });
    const lines: string[] = [];
    lines.push('structural family  hash=' + hash.slice(0, 8) + '  members=' + rows.length + '  variants=' + variants.size);
    lines.push(pad('id', 12) + pad('page', 14) + pad('type', 10) + pad('nodes', 7) + pad('var', 8) + 'headline');
    for (const r of rows) {
      lines.push(pad(r.id, 12) + pad(r.page, 14) + pad(r.type, 10) + pad(String(r.nodes), 7) + pad(r.key, 8) + headlineOf(r.texts));
    }
    lines.push('');
    lines.push('variants:');
    const sorted = [...variants.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [k, ids] of sorted) {
      const s = slotsOf(g, ids[0]);
      const head = headlineOf(s.texts);
      lines.push('  ' + k + ' x' + String(ids.length).padEnd(3) + head.slice(0, 56));
    }
    emit(
      {
        command: 'family',
        target: id,
        hash,
        members: rows,
        variants: sorted.map(([key, ids]) => ({ key, count: ids.length, ids })),
      },
      lines.join('\n'),
    );
    return;
  }

  if (cmd === 'profile') {
    let ids: string[] = [];
    let label = '';
    if (OPT.page) {
      for (const [id, n] of g.nodes) if (n.page_name === OPT.page) ids.push(id);
      if (ids.length === 0) fail('page not found: ' + OPT.page);
      label = 'page:' + OPT.page;
    } else {
      const id = positional[0] ?? fail('profile needs a node id or --page');
      if (!g.nodes.has(id)) fail('node not found: ' + id, 'not_found');
      ids = g.subtree(id);
      label = g.nodes.get(id)!.name + ' (' + id + ')';
    }
    const p = profileOf(g, OPT.db, ids);
    const lines = [
      'style profile  ' + label,
      'nodes ' + p.nodes + '  texts ' + p.texts + '  instances ' + p.instances + '  icons ' + p.icons,
      'palette   ' + p.palette.size + ' colors  ' + fmtMap(p.palette, 6),
      'radii     ' + p.radii.size + ' values  ' + fmtMap(p.radii, 6),
      'type      ' + p.fonts.size + ' combos  ' + fmtMap(p.fonts, 5),
      'sizes     ' + p.sizes.size + ' values  ' + fmtMap(p.sizes, 8),
      'effects   ' + fmtMap(p.effects, 5),
      'spacing   ' + fmtMap(p.spacing, 6),
      'tokens    ' + p.tokens + ' nodes bound  libraries ' + p.tokenLibraries,
      'types     ' + fmtMap(p.types, 8),
    ];
    emit(
      {
        command: 'profile',
        target: label,
        nodes: p.nodes,
        palette: topEntries(p.palette, 50),
        radii: topEntries(p.radii, 50),
        fonts: topEntries(p.fonts, 50),
        sizes: topEntries(p.sizes, 50),
        effects: topEntries(p.effects, 20),
        spacing: topEntries(p.spacing, 20),
        tokens: p.tokens,
        tokenLibraries: p.tokenLibraries,
        types: Object.fromEntries(p.types),
      },
      lines.join('\n'),
    );
    return;
  }

  if (cmd === 'diff') {
    const a = positional[0] ?? fail('diff needs two node ids', 'missing_input');
    const b = positional[1] ?? fail('diff needs two node ids', 'missing_input');
    if (!g.nodes.has(a) || !g.nodes.has(b)) fail('node not found', 'not_found');
    const d = diffScreens(g, OPT.db, a, b);
    const lines = [
      'diff  ' + d.a.id + ' (' + d.a.name + ')  vs  ' + d.b.id + ' (' + d.b.name + ')',
      'structure  isomorphic=' + (d.structure.isomorphic ? 'YES' : 'no') +
        '  type-cosine=' + d.structure.typeCosine.toFixed(3) +
        '  nodes ' + d.a.nodes + '/' + d.b.nodes +
        '  depth ' + d.structure.depthA + '/' + d.structure.depthB,
      'copy       jaccard=' + d.copy.jaccard.toFixed(3) + '  only-A=' + d.copy.onlyA + ' only-B=' + d.copy.onlyB,
      'icons      jaccard=' + d.icons.jaccard.toFixed(3) + '  shared=' + d.icons.shared + '  ' + d.icons.countA + '/' + d.icons.countB,
      'palette    jaccard=' + d.palette.jaccard.toFixed(3) + '  colors ' + d.palette.countA + '/' + d.palette.countB,
      'radii      jaccard=' + d.radii.jaccard.toFixed(3),
      'type       jaccard=' + d.fonts.jaccard.toFixed(3),
      'effects    ' + fmtMap(new Map(d.effects.a), 4) + ' | ' + fmtMap(new Map(d.effects.b), 4),
      'tokens     ' + d.tokens.a + '/' + d.tokens.aNodes + ' vs ' + d.tokens.b + '/' + d.tokens.bNodes,
      '',
      'not judgeable from the AST: visual hierarchy, iconography style, composition balance,',
      '                            illustration style, optical spacing, perceived novelty.',
    ];
    emit(d, lines.join('\n'));
    return;
  }

  if (cmd === 'sheets') {
    const roots: string[] = [];
    const cand = new Set<string>();
    for (const [id, n] of g.nodes) {
      if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') continue;
      if (Math.abs((n.bbox_w ?? 0) - 390) > 4 || Math.abs((n.bbox_h ?? 0) - 844) > 6) continue;
      cand.add(id);
    }
    for (const id of cand) {
      let p = g.nodes.get(id)?.parent_id ?? null;
      let nested = false;
      while (p) {
        if (cand.has(p)) { nested = true; break; }
        p = g.nodes.get(p)?.parent_id ?? null;
      }
      if (!nested) roots.push(id);
    }
    roots.sort();

    const famCache = new Map<string, DerivedFamily>();
    for (const id of roots) {
      const hash = g.hash.get(id)!;
      if (famCache.has(hash)) continue;
      const members = g.topLevelMembers(hash).filter((m) => g.subtree(m).length >= 120);
      famCache.set(hash, members.length >= 2 ? deriveFamilyAxes(g, members, OPT.hint) : { family: hash.slice(0, 12), nameHint: '', members: members.length, axes: [], unresolved: [] });
    }

    let groups: GroupStats[] = [];
    try {
      groups = groupStats(g, OPT.db, loadLabels(OPT.labels).labels);
    } catch {
      groups = [];
    }

    const cards: Array<Record<string, unknown>> = [];
    for (const id of roots) {
      const sub = g.subtree(id);
      if (sub.length < 40) continue;
      const node = g.nodes.get(id)!;
      const p = profileOf(g, OPT.db, sub);
      const s = slotsOf(g, id);
      const hash = g.hash.get(id)!;
      const fam = famCache.get(hash)!;
      const hit = fam.axes.filter((a) => a.members.indexOf(id) !== -1)[0];
      let generation = 'unlabelled';
      if (groups.length > 0) generation = decideLabel(classifyWith(g, OPT.db, id, groups), OPT.floor).verdict;
      cards.push({
        id,
        name: node.name,
        page: node.page_name,
        page_id: node.page_id,
        type: node.type,
        bbox: [Math.round(node.bbox_x ?? 0), Math.round(node.bbox_y ?? 0), Math.round(node.bbox_w ?? 0), Math.round(node.bbox_h ?? 0)],
        hash: hash.slice(0, 12),
        nodes: sub.length,
        depth: g.depthOf(id),
        family_members: fam.members,
        family_axes: fam.axes.length,
        axis: hit ? hit.key : null,
        axis_siblings: hit ? hit.members.length : 0,
        axis_samples: hit ? hit.samples : [],
        colors: p.palette.size,
        palette_top: topEntries(p.palette, 5),
        radii_top: topEntries(p.radii, 5),
        fonts_top: topEntries(p.fonts, 4),
        tokens: p.tokens,
        token_ratio: Number((p.nodes > 0 ? p.tokens / p.nodes : 0).toFixed(4)),
        token_libraries: p.tokenLibraries,
        types: Object.fromEntries(p.types),
        archetype: archetypeOf(g, id),
        headline: headlineOf(s.texts),
        generation,
      });
    }

    const dupKey = (c: Record<string, unknown>): string => String(c.hash) + '|' + String(c.headline);
    const counts = new Map<string, number>();
    for (const c of cards) counts.set(dupKey(c), (counts.get(dupKey(c)) ?? 0) + 1);
    const seen = new Set<string>();
    const uniqueCards: Array<Record<string, unknown>> = [];
    for (const c of cards) {
      const k = dupKey(c);
      c.copies = counts.get(k) ?? 1;
      if (OPT.unique) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      uniqueCards.push(c);
    }
    cards.length = 0;
    for (const c of uniqueCards) cards.push(c);

    const outJsonl = OPT.out ? resolve(ROOT, OPT.out) : resolve(SCRATCH, 'sheets.jsonl');
    if (!(outJsonl === SCRATCH || outJsonl.startsWith(SCRATCH + sep))) {
      fail('--out must stay inside .scratch/');
    }
    mkdirSync(dirname(outJsonl), { recursive: true });
    writeFileSync(outJsonl, cards.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');

    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const cols = ['id', 'name', 'page', 'type', 'archetype', 'hash', 'nodes', 'depth', 'family_members', 'family_axes', 'axis', 'axis_siblings', 'copies', 'colors', 'tokens', 'token_ratio', 'generation', 'headline'];
    const csv = [cols.join(',')].concat(cards.map((c) => cols.map((k) => esc(c[k])).join(','))).join('\n') + '\n';
    writeFileSync(resolve(dirname(outJsonl), 'sheets.csv'), csv, 'utf8');

    const byGen = new Map<string, number>();
    let withAxis = 0;
    for (const c of cards) {
      byGen.set(String(c.generation), (byGen.get(String(c.generation)) ?? 0) + 1);
      if (c.axis) withAxis += 1;
    }
    const lines = [
      'sheets  screens=' + cards.length,
      'jsonl   ' + outJsonl,
      'csv     ' + resolve(dirname(outJsonl), 'sheets.csv'),
      'labels  ' + groups.map((x) => x.label).join(', '),
      'with variant axis  ' + withAxis + '/' + cards.length,
      'generation  ' + [...byGen.entries()].map(([k, v]) => k + ':' + v).join('  '),
    ];
    // emit() honours --out; clear it so the summary does not overwrite the jsonl just written.
    OPT.out = null;
    emit({ command: 'sheets', count: cards.length, jsonl: outJsonl, generation: Object.fromEntries(byGen), withAxis }, lines.join('\n'));
    return;
  }
  if (cmd === 'markers') {
    let raw = '';
    try {
      raw = readFileSync(OPT.screenLabels, 'utf8');
    } catch {
      fail('screen labels not found: ' + OPT.screenLabels);
    }
    const data = JSON.parse(raw) as { screens: ScreenLabel[] };
    const dCount = new Map<string, number>();
    const pCount = new Map<string, number>();
    const dialogs: string[] = [];
    const pages: string[] = [];
    for (const s of data.screens ?? []) {
      if (!g.nodes.has(s.id)) continue;
      const comps = componentsOf(g, s.id);
      if (s.kind === 'dialog') {
        dialogs.push(s.id);
        for (const c of comps) dCount.set(c, (dCount.get(c) ?? 0) + 1);
      } else {
        pages.push(s.id);
        for (const c of comps) pCount.set(c, (pCount.get(c) ?? 0) + 1);
      }
    }
    const minSupport = 3;
    const markers = [...dCount.entries()]
      .filter(([c, n]) => n >= minSupport && (pCount.get(c) ?? 0) === 0)
      .map(([id, n]) => ({ id, dialogs: n, pages: pCount.get(id) ?? 0 }))
      .sort((a, b) => b.dialogs - a.dialogs || (a.id < b.id ? -1 : 1));
    const markerSet = new Set(markers.map((m) => m.id));
    let covered = 0;
    for (const id of dialogs) {
      if (hasDialogMarker(g, id, markerSet)) covered += 1;
    }
    const outPath = OPT.out ? resolve(ROOT, OPT.out) : resolve(SCRATCH, 'archetype.json');
    if (!(outPath === SCRATCH || outPath.startsWith(SCRATCH + sep) || outPath === OPT.markers)) {
      fail('--out must stay inside .scratch/ (unless it is the --markers path)');
    }
    const payload = {
      version: 1,
      sample: '2026-11-13-baipai-14p-newold',
      rule: 'component appears in >= ' + minSupport + ' labeled dialogs and 0 labeled pages',
      coverage: { dialogs: dialogs.length, covered, pages: pages.length },
      markers,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    const lines = [
      'markers  dialogs=' + dialogs.length + '  pages=' + pages.length + '  candidates=' + markers.length,
      'coverage ' + covered + '/' + dialogs.length + ' dialogs contain a marker',
      '',
      pad('component', 12) + pad('dialogs', 9) + 'pages',
    ];
    for (const m of markers.slice(0, 15)) lines.push(pad(m.id, 12) + pad(String(m.dialogs), 9) + m.pages);
    lines.push('');
    lines.push('written to ' + outPath);
    emit(payload, lines.join('\n'));
    return;
  }

  if (cmd === 'apply') {
    const mdPath = OPT.md;
    let text = '';
    try {
      text = readFileSync(mdPath, 'utf8');
    } catch {
      fail('markdown not found: ' + mdPath + ' (pass --md <file>)');
    }
    const lines = text.split('\n').filter((l) => l.trim().startsWith('|'));
    if (lines.length < 2) fail('no markdown table found in ' + mdPath);
    const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const header = cells(lines[0]);
    const idx = (names: string[]): number => header.findIndex((h) => names.some((n) => h.indexOf(n) !== -1));
    const iId = idx(['ID']);
    const iCat = idx(['正確分類', '分類']);
    const iNote = idx(['備註']);
    if (iId === -1) fail('table has no ID column (header: ' + header.join(' | ') + ')');

    let labelsRaw = '';
    try {
      labelsRaw = readFileSync(OPT.screenLabels, 'utf8');
    } catch {
      fail('screen labels not found: ' + OPT.screenLabels);
    }
    const doc = JSON.parse(labelsRaw) as { screens: ScreenLabel[]; taxonomy?: Record<string, string[]>; version?: number; note?: string };
    const byId = new Map<string, ScreenLabel>();
    for (const s of doc.screens ?? []) byId.set(s.id, s);
    const known = new Set<string>();
    try {
      for (const line of readFileSync(OPT.input, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        known.add(String((JSON.parse(line) as Record<string, unknown>).id));
      }
    } catch {
      // no sheets: fall back to updating only existing labels
    }

    const updates: Array<{ id: string; before: string; after: string; note: string; isNew: boolean }> = [];
    const unknown: string[] = [];
    const seenIds = new Set<string>();
    for (const line of lines.slice(1)) {
      const row = cells(line);
      if (row.every((c) => /^:?-+:?$/.test(c) || c === '')) continue;
      const id = row[iId] ?? '';
      if (!id || /^:?-+:?$/.test(id)) continue;
      const cat = iCat >= 0 ? (row[iCat] ?? '') : '';
      const note = iNote >= 0 ? (row[iNote] ?? '') : '';
      const clean = (v: string): string => (v === '-' || v === '—' ? '' : v);
      const newCat = clean(cat);
      const newNote = clean(note);
      if (!newCat && !newNote) continue;
      const alreadyCounted = seenIds.has(id);
      seenIds.add(id);
      const taxonomy = doc.taxonomy ?? { page: [], dialog: [] };
      if (newCat && taxonomy.page.indexOf(newCat) !== -1 && taxonomy.dialog.indexOf(newCat) !== -1) {
        fail('category is ambiguous between page and dialog: ' + newCat, 'invalid_argument', 'rename one of the categories in labels/screens.json taxonomy');
      }
      let existing = byId.get(id);
      const wasNew = !existing;
      if (!existing) {
        if (!known.has(id)) {
          unknown.push(id);
          continue;
        }
        existing = { id, category: newCat || '未分類', kind: /彈窗|dialog|popup|modal/i.test(newCat) ? 'dialog' : 'page' } as ScreenLabel;
        doc.screens.push(existing);
        byId.set(id, existing);
      }
      const before = wasNew ? '(new)' : existing.category;
      if (newCat && newCat !== before) {
        existing.category = newCat;
        existing.kind = /彈窗|dialog|popup|modal/i.test(newCat) ? 'dialog' : 'page';
      }
      if (newNote) {
        existing.note = existing.note && existing.note !== newNote ? existing.note + ' / ' + newNote : newNote;
      }
      if (!alreadyCounted && (newCat !== before || newNote)) updates.push({ id, before, after: existing.category, note: newNote, isNew: wasNew });
    }

    for (const u of updates) {
      const e = byId.get(u.id);
      if (e) u.after = e.category;
    }
    const updatedCount = updates.filter((u) => !u.isNew).length;
    const addedCount = updates.filter((u) => u.isNew).length;
    const linesOut = ['apply  source=' + mdPath + '  updated=' + updatedCount + '  added=' + addedCount + '  unknown=' + unknown.length];
    for (const u of updates.slice(0, OPT.top)) {
      linesOut.push('  ' + pad(u.id, 12) + (u.before + ' -> ' + u.after).slice(0, 30).padEnd(32) + (u.note ? '| ' + u.note.slice(0, 30) : ''));
    }
    if (unknown.length > 0) linesOut.push('  unknown ids (not in labels): ' + unknown.slice(0, 6).join(' '));
    if (OPT.dryRun) {
      linesOut.push('dry run — nothing written');
    } else {
      const outPath = OPT.screenLabels;
      writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      linesOut.push('written ' + outPath);
      linesOut.push('next: npm run query -- propagate && npm run query -- review');
    }
    OPT.out = null;
    emit({ command: 'apply', source: mdPath, updated: updates, unknown, dryRun: OPT.dryRun }, linesOut.join('\n'));
    return;
  }

  if (cmd === 'category') {
    const name = positional[0] ?? fail('category needs a category name', 'missing_input');
    let doc: { screens: ScreenLabel[]; taxonomy?: Record<string, string[]> };
    try {
      doc = JSON.parse(readFileSync(OPT.screenLabels, 'utf8')) as { screens: ScreenLabel[]; taxonomy?: Record<string, string[]> };
    } catch {
      fail('labels/screens.json not readable', 'not_found');
    }
    const all = doc.screens ?? [];
    const known = new Set<string>();
    for (const list of Object.values(doc.taxonomy ?? {})) for (const c of list) known.add(c);
    for (const s of all) known.add(s.category);
    if (!known.has(name)) {
      const near = [...known].filter((c) => c.indexOf(name) !== -1 || name.indexOf(c) !== -1).slice(0, 6);
      fail('unknown category: ' + name, 'not_found', near.length > 0 ? 'did you mean: ' + near.join(', ') : 'run "npm run query -- manifest" for the tool list');
    }
    const items = all
      .filter((s) => s.category === name)
      .map((s) => {
        const n = g.nodes.get(s.id);
        return {
          id: s.id,
          name: n ? n.name : '(missing in sample)',
          page: n ? n.page_name : '',
          archetype: n ? archetypeOf(g, s.id) : '',
          note: s.note ?? '',
          predicted: false,
        };
      })
      .filter((x) => x.name !== '(missing in sample)');

    const total = items.length;
    const threshold = 40;
    const sampleSize = Math.max(1, OPT.sample);
    let shown = items;
    let sampled = false;
    if (total > threshold && !OPT.all) {
      const step = total / sampleSize;
      shown = [];
      for (let i = 0; i < sampleSize; i += 1) shown.push(items[Math.min(total - 1, Math.floor(i * step))]);
      sampled = true;
    }
    const lines = [
      'category  ' + name,
      'total     ' + total + (sampled ? '  → showing ' + shown.length + ' (sampled; pass --all for the full list)' : '  (all shown)'),
    ];
    if (total > threshold && !sampled) lines.push('note       category exceeds ' + threshold + ' pages; full list requested explicitly');
    lines.push('');
    lines.push(pad('id', 12) + pad('page', 14) + pad('archetype', 15) + 'name');
    for (const it of shown) lines.push(pad(it.id, 12) + pad(it.page.slice(0, 12), 14) + pad(it.archetype, 15) + it.name.slice(0, 38));
    if (sampled) lines.push('');
    if (sampled) lines.push('sampling is a spot-check, not a silent truncation: total=' + total + ' shown=' + shown.length);
    emit({ command: 'category', category: name, total, shown: shown.length, sampled, threshold, items: shown }, lines.join('\n'));
    return;
  }

  if (cmd === 'verify-source') {
    const problems: Array<Record<string, unknown>> = [];
    const doc = JSON.parse(readFileSync(OPT.screenLabels, 'utf8')) as { screens: ScreenLabel[] };
    let checkedLabels = 0;
    for (const s of doc.screens ?? []) {
      checkedLabels += 1;
      const n = g.nodes.get(s.id);
      if (!n) problems.push({ source: 'labels/screens.json', id: s.id, problem: 'missing in sample' });
    }
    let checkedPredictions = 0;
    try {
      const raw = readFileSync(resolve(SCRATCH, 'predictions.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const p = JSON.parse(line) as { id: string; name: string };
        checkedPredictions += 1;
        const n = g.nodes.get(p.id);
        if (!n) problems.push({ source: 'predictions.jsonl', id: p.id, problem: 'missing in sample' });
        else if (n.name !== p.name) problems.push({ source: 'predictions.jsonl', id: p.id, problem: 'name mismatch: queue="' + p.name + '" db="' + n.name + '"' });
      }
    } catch {
      problems.push({ source: 'predictions.jsonl', id: null, problem: 'not found (run sync)' });
    }
    let checkedQueue = 0;
    try {
      const raw = readFileSync(resolve(SCRATCH, 'review-queue.md'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.startsWith('| ') || line.indexOf('| ID |') === 0) continue;
        const cells2 = line.split('|').map((x) => x.trim());
        const id = cells2[1] ?? '';
        if (!id || id === 'ID' || /^:?-+:?$/.test(id)) continue;
        checkedQueue += 1;
        if (!g.nodes.has(id)) problems.push({ source: 'review-queue.md', id, problem: 'missing in sample' });
      }
    } catch {
      checkedQueue = -1;
    }
    const lines = [
      'verify-source  every id/name must come from the SQLite graph',
      'checked  labels=' + checkedLabels + '  predictions=' + checkedPredictions + '  queue=' + (checkedQueue < 0 ? 'missing' : String(checkedQueue)),
    ];
    for (const p of problems.slice(0, 20)) lines.push('  FAIL  ' + p.source + ' ' + String(p.id) + '  ' + p.problem);
    lines.push('');
    if (problems.length > 0) {
      lines.push('RESULT: FAIL  (' + problems.length + ' mismatches)');
      OPT.out = null;
      emit({ command: 'verify-source', checked: { labels: checkedLabels, predictions: checkedPredictions, queue: checkedQueue }, problems }, lines.join('\n'));
      process.exitCode = 1;
      return;
    }
    lines.push('RESULT: OK — every id exists in the sample and every name matches');
    OPT.out = null;
    emit({ command: 'verify-source', checked: { labels: checkedLabels, predictions: checkedPredictions, queue: checkedQueue }, problems: [] }, lines.join('\n'));
    return;
  }

  if (cmd === 'review') {
    let sheetsRaw = '';
    try {
      sheetsRaw = readFileSync(OPT.input, 'utf8');
    } catch {
      fail('sheets not found: ' + OPT.input + ' (run "sheets --unique" first)');
    }
    const sheets = new Map<string, Record<string, unknown>>();
    for (const line of sheetsRaw.split('\n')) {
      if (!line.trim()) continue;
      const c = JSON.parse(line) as Record<string, unknown>;
      sheets.set(String(c.id), c);
    }
    let predRaw = '';
    try {
      predRaw = readFileSync(resolve(SCRATCH, 'predictions.jsonl'), 'utf8');
    } catch {
      fail('predictions not found (run "propagate" first)');
    }
    const preds = predRaw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const catSet = new Set<string>();
    try {
      const lf = JSON.parse(readFileSync(OPT.screenLabels, 'utf8')) as { screens: ScreenLabel[]; taxonomy?: Record<string, string[]> };
      for (const s of lf.screens ?? []) catSet.add(s.category);
      for (const list of Object.values(lf.taxonomy ?? {})) for (const c of list) catSet.add(c);
    } catch {
      // ignore
    }
    const categories = [...catSet].sort();
    const groupBy = OPT.groupBy === 'archetype' ? 'archetype' : 'category';
    let mode: 'pending' | 'labeled' = 'pending';
    let entries: Array<{ id: string; category: string; confidence: number; labeled: boolean }> = [];
    if (OPT.category) {
      const pending = preds.filter((p) => String(p.category ?? '') === OPT.category);
      if (pending.length > 0) {
        entries = pending.map((p) => ({ id: String(p.id), category: String(p.category ?? ''), confidence: Number(p.confidence ?? 0), labeled: false }));
      } else {
        let labelled: ScreenLabel[] = [];
        try {
          labelled = (JSON.parse(readFileSync(OPT.screenLabels, 'utf8')) as { screens: ScreenLabel[] }).screens ?? [];
        } catch {
          labelled = [];
        }
        const sel = labelled.filter((s) => s.category === OPT.category);
        if (sel.length === 0) {
          const near = categories.filter((c) => c.indexOf(OPT.category as string) !== -1 || (OPT.category as string).indexOf(c) !== -1).slice(0, 6);
          fail('no screens for category: ' + OPT.category, 'not_found', near.length > 0 ? 'did you mean: ' + near.join(', ') : 'see labels/screens.json taxonomy');
        }
        mode = 'labeled';
        entries = sel.map((s) => ({ id: s.id, category: s.category, confidence: 1, labeled: true }));
      }
    } else {
      entries = preds.map((p) => ({ id: String(p.id), category: String(p.category ?? ''), confidence: Number(p.confidence ?? 0), labeled: false }));
    }
    const cards = entries.map((e) => {
      const s = sheets.get(e.id) ?? {};
      return {
        id: e.id,
        name: String(s.name ?? ''),
        page: String(s.page ?? ''),
        pageId: String(s.page_id ?? ''),
        archetype: String(s.archetype ?? ''),
        generation: String(s.generation ?? 'unknown'),
        predicted: e.category,
        confidence: e.confidence,
        labeled: e.labeled,
        headline: String(s.headline ?? ''),
        nodes: Number(s.nodes ?? 0),
        copies: Number(s.copies ?? 1),
        group: groupBy === 'archetype' ? String(s.archetype ?? '') : (e.category || '未分類'),
        palette: ((s.palette_top as Array<[string, number]>) ?? []).slice(0, 5).map((x) => x[0]),
      };
    });
    const groupCounts = new Map<string, number>();
    for (const c of cards) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1);
    const groups = [...groupCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, label: key || '未分類', count }));
    const groupLabel = groupBy === 'archetype' ? '版面原型' : '預測分類';
    const payload = JSON.stringify({ cards, categories, groups, groupLabel, mode });
    const html: string[] = [];
    html.push('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>Rea-FigmaDesign 分類排查</title>');
    html.push('<style>');
    html.push('*{box-sizing:border-box}body{margin:0;display:flex;background:#0e1117;color:#e6e8ee;font:13px/1.55 -apple-system,"PingFang TC",system-ui,sans-serif}');
    html.push('aside{width:212px;flex:0 0 212px;height:100vh;position:sticky;top:0;border-right:1px solid #212734;padding:16px 12px;overflow:auto}');
    html.push('aside h3{font-size:11px;letter-spacing:.08em;color:#7d879c;margin:0 0 8px;text-transform:uppercase}');
    html.push('aside a{display:flex;justify-content:space-between;gap:8px;padding:7px 9px;border-radius:7px;color:#c8cfe0;text-decoration:none;font-size:13px}');
    html.push('aside a:hover{background:#171d28}aside a b{color:#7d879c;font-weight:500}');
    html.push('main{flex:1;min-width:0;padding-bottom:80px}header{position:sticky;top:0;z-index:6;background:#0e1117ee;backdrop-filter:blur(6px);border-bottom:1px solid #212734;padding:12px 18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}');
    html.push('h1{font-size:14px;margin:0;font-weight:600}.muted{color:#7d879c;font-size:12px}');
    html.push('button{background:#222a38;border:1px solid #2c3546;color:#dfe4f0;padding:6px 11px;border-radius:7px;font-size:12px;cursor:pointer}');
    html.push('button.primary{background:#2f6df6;border-color:#2f6df6;color:#fff}button.on{border-color:#2f6df6;color:#fff}');
    html.push('table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;color:#7d879c;font-weight:500;padding:8px 10px;border-bottom:1px solid #212734;position:sticky;top:53px;background:#0e1117}');
    html.push('td{padding:7px 10px;border-bottom:1px solid #171d27;vertical-align:middle}');
    html.push('tr:hover td{background:#121824}tr.sel td{background:#152036}');
    html.push('.id{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#9fb4ff;cursor:copy;white-space:nowrap}');
    html.push('.gen{font-size:11px;padding:1px 7px;border-radius:99px;background:#1b2230;color:#9aa6bd;white-space:nowrap}.gen.new{background:#173225;color:#6fe0a4}.gen.old{background:#33211f;color:#f0a08a}');
    html.push('.copy{color:#aeb8cc;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}');
    html.push('.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:3px;border:1px solid #00000055;vertical-align:-2px}');
    html.push('input.note{width:100%;background:#121824;border:1px solid #242c3a;color:#e6e8ee;border-radius:6px;padding:5px 7px;font-size:12px}');
    html.push('.batchnote{width:230px;background:#121824;border:1px solid #2c3546;color:#e6e8ee;border-radius:6px;padding:6px 8px;font-size:12px}');
    html.push('select{background:#121824;border:1px solid #242c3a;color:#e6e8ee;border-radius:6px;padding:4px 6px;font-size:12px;max-width:170px}');
    html.push('section{padding:0 18px 40px}h2{font-size:12px;color:#8b95aa;margin:22px 0 8px;letter-spacing:.06em;text-transform:uppercase}');
    html.push('input[type=checkbox]{accent-color:#2f6df6;width:14px;height:14px;cursor:pointer}');
    html.push('.bar{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;background:#182030;border:1px solid #2c3546;border-radius:12px;padding:10px 14px;display:none;gap:10px;align-items:center;box-shadow:0 10px 30px #0008;z-index:9}');
    html.push('.bar.show{display:flex}.bar select{max-width:200px}');
    html.push('.toast{position:fixed;bottom:18px;right:18px;background:#2f6df6;color:#fff;padding:9px 14px;border-radius:8px;opacity:0;transition:.2s;font-size:12px;z-index:10}');
    html.push('.toast.show{opacity:1}');
    html.push('</style>');
    html.push('<aside><h3 id="navtitle"></h3><div id="nav"></div></aside>');
    html.push('<main><header><h1>分類排查</h1><span class="muted" id="stat"></span><span class="muted" style="color:#e0a03a">預測僅為建議，最終以你的判定為準</span><span style="flex:1"></span><select id="filter"><option value="all">全部</option><option value="split">只看分裂（≤0.33）</option><option value="majority">只看多數（0.67）</option><option value="unanimous">只看全票（1.0）</option></select>');
    html.push('<button id="pickall">全選</button><button id="clearall">清除選取</button><button id="copy" class="primary">複製 Markdown</button></header><section id="body"></section></main>');
    html.push('<div class="bar" id="bar"><span class="muted" id="barcount"></span><select id="batchsel"></select><button class="primary" id="apply">套用分類</button><input class="batchnote" id="batchnote" placeholder="批次備註（套用到選取列）"><button id="applynote">套用備註</button><button id="copyids">複製 ID</button><button id="copycode">複製 Figma 指令</button><button id="barcopy">複製選取</button></div>');
    html.push('<div class="toast" id="toast"></div>');
    html.push('<script>const DATA=' + payload + ';');
    html.push('const GROUPS=DATA.groups;document.getElementById("navtitle").textContent=DATA.groupLabel;');
    html.push('const LABELS=DATA.categories;const by={};DATA.cards.forEach(function(c){by[c.id]=c});');
    html.push('const picked=new Set();let lastIdx=-1;');
    html.push('function toast(m){const t=document.getElementById("toast");t.textContent=m;t.classList.add("show");setTimeout(function(){t.classList.remove("show")},1500)}');
    html.push('function syncBar(){const bar=document.getElementById("bar");document.getElementById("barcount").textContent="已選 "+picked.size+" 列";bar.classList.toggle("show",picked.size>0);');
    html.push('document.querySelectorAll("tr[data-id]").forEach(function(tr){tr.classList.toggle("sel",picked.has(tr.dataset.id))})}');
    html.push('function build(){const body=document.getElementById("body");const nav=document.getElementById("nav");body.innerHTML="";nav.innerHTML="";');
    html.push('const bs=document.getElementById("batchsel");bs.innerHTML="";const o0=new Option("— 批次分類 —","");bs.appendChild(o0);LABELS.forEach(function(l){bs.appendChild(new Option(l,l))});');
    html.push('GROUPS.forEach(function(g){const list=DATA.cards.filter(function(c){return c.group===g.key});if(!list.length)return;');
    html.push('const a=document.createElement("a");a.href="#g-"+g.key;a.innerHTML="<span>"+g.label+"</span><b>"+list.length+"</b>";nav.appendChild(a);');
    html.push('const h=document.createElement("h2");h.id="g-"+g.key;h.textContent=g.label+" · "+list.length;body.appendChild(h);');
    html.push('const t=document.createElement("table");t.innerHTML="<thead><tr><th style=\'width:30px\'></th><th style=\'width:104px\'>ID</th><th>名稱</th><th style=\'width:112px\'>頁面</th><th style=\'width:64px\'>複本</th><th style=\'width:62px\'>狀態</th><th style=\'width:150px\'>預測分類</th><th style=\'width:86px\'>信心</th><th>文案</th><th style=\'width:92px\'>色票</th><th style=\'width:240px\'>備註</th></tr></thead>";');
    html.push('const tb=document.createElement("tbody");');
    html.push('list.forEach(function(c,idx){const tr=document.createElement("tr");tr.dataset.id=c.id;tr.dataset.gen=c.generation;');
    html.push('const ck=document.createElement("td");const box=document.createElement("input");box.type="checkbox";ck.appendChild(box);tr.appendChild(ck);');
    html.push('box.onchange=function(ev){if(ev.shiftKey&&lastIdx>=0){const all=Array.prototype.slice.call(document.querySelectorAll("tr[data-id]"));const a=all.indexOf(tr);const lo=Math.min(a,lastIdx),hi=Math.max(a,lastIdx);for(let i=lo;i<=hi;i++){const x=all[i];picked.add(x.dataset.id);const b=x.querySelector("input[type=checkbox]");if(b)b.checked=true}}else{if(box.checked)picked.add(c.id);else picked.delete(c.id)}lastIdx=Array.prototype.slice.call(document.querySelectorAll("tr[data-id]")).indexOf(tr);syncBar()};');
    html.push('const id=document.createElement("td");const s=document.createElement("span");s.className="id";s.textContent=c.id;s.title="點擊複製 ID";s.onclick=function(){navigator.clipboard.writeText(c.id);toast("已複製 "+c.id)};id.appendChild(s);tr.appendChild(id);');
    html.push('const nm=document.createElement("td");nm.textContent=c.name||"(無名)";tr.appendChild(nm);const pg=document.createElement("td");pg.className="muted";pg.textContent=c.page||"";tr.appendChild(pg);const cp2=document.createElement("td");cp2.className="muted";cp2.textContent=c.copies>1?("x"+c.copies):"-";cp2.title=c.copies>1?("此 ID 代表 "+c.copies+" 份相同畫面"):"";tr.appendChild(cp2);');
    html.push('const gcl=document.createElement("td");const gb=document.createElement("span");gb.className="gen "+c.generation;gb.textContent=c.generation;gcl.appendChild(gb);tr.appendChild(gcl);');
    html.push('const pc=document.createElement("td");const sel=document.createElement("select");sel.appendChild(new Option("— 選分類 —",""));LABELS.forEach(function(l){const o=new Option(l,l);if(l===c.predicted)o.selected=true;sel.appendChild(o)});sel.className="pred";pc.appendChild(sel);tr.appendChild(pc);const cfd=document.createElement("td");const band=c.confidence>=0.99?"全票":(c.confidence>=0.6?"多數":"分裂");cfd.className="muted";cfd.textContent=band+" "+Math.round(c.confidence*100)+"%";tr.appendChild(cfd);');
    html.push('const cp=document.createElement("td");cp.className="copy";cp.textContent=c.headline||"";cp.title=c.headline||"";tr.appendChild(cp);');
    html.push('const sw=document.createElement("td");c.palette.forEach(function(hx){const d=document.createElement("span");d.className="sw";d.style.background=hx;d.title=hx;sw.appendChild(d)});tr.appendChild(sw);');
    html.push('const nt=document.createElement("td");const inp=document.createElement("input");inp.className="note";inp.placeholder="發現的問題／正確分類";nt.appendChild(inp);tr.appendChild(nt);');
    html.push('tb.appendChild(tr)});t.appendChild(tb);body.appendChild(t);});');
    html.push('document.getElementById("filter").onchange=function(){const v=this.value;document.querySelectorAll("tr[data-id]").forEach(function(tr){const c=by[tr.dataset.id];const b=c.confidence>=0.99?"unanimous":(c.confidence>=0.6?"majority":"split");tr.style.display=(v==="all"||v===b)?"":"none"})};');
    html.push('document.getElementById("stat").textContent=(DATA.mode==="labeled"?"已標註檢視 · ":"待排查 · ")+DATA.cards.length+" 列 · 點 ID 可複製 · Shift 連選 · 勾選後可批次套用";syncBar()}');
    html.push('function rowsData(list){return list.map(function(tr){const c=by[tr.dataset.id];const sel=tr.querySelector("select.pred");const note=tr.querySelector("input.note").value.trim();return{id:c.id,name:c.name,gen:c.generation,predicted:c.predicted,final:sel.value||c.predicted,note:note}})}');
    html.push('function md(rows){if(!rows.length){toast("沒有需要回報的列");return}let out="| ID | 名稱 | 狀態 | 原預測 | 正確分類 | 備註 |\\n|---|---|---|---|---|---|\\n";rows.forEach(function(r){out+="| "+r.id+" | "+(r.name||"-")+" | "+r.gen+" | "+r.predicted+" | "+r.final+" | "+(r.note||"-")+" |\\n"});navigator.clipboard.writeText(out).then(function(){toast("已複製 "+rows.length+" 列 Markdown")})}');
    html.push('function changed(){const all=Array.prototype.slice.call(document.querySelectorAll("tr[data-id]"));return rowsData(all.filter(function(tr){const c=by[tr.dataset.id];const sel=tr.querySelector("select.pred");const note=tr.querySelector("input.note").value.trim();return note||(sel.value&&sel.value!==c.predicted)}))}');
    html.push('document.getElementById("pickall").onclick=function(){document.querySelectorAll("tr[data-id]").forEach(function(tr){picked.add(tr.dataset.id);const b=tr.querySelector("input[type=checkbox]");if(b)b.checked=true});syncBar()};');
    html.push('document.getElementById("clearall").onclick=function(){picked.clear();document.querySelectorAll("tr[data-id]").forEach(function(tr){const b=tr.querySelector("input[type=checkbox]");if(b)b.checked=false});syncBar()};');
    html.push('document.getElementById("apply").onclick=function(){const v=document.getElementById("batchsel").value;if(!v){toast("先選一個分類");return}let n=0;document.querySelectorAll("tr[data-id]").forEach(function(tr){if(!picked.has(tr.dataset.id))return;tr.querySelector("select.pred").value=v;n++});toast("已套用 "+v+" 到 "+n+" 列")};');
    html.push('document.getElementById("copy").onclick=function(){md(changed())};');
    html.push('document.getElementById("applynote").onclick=function(){const v=document.getElementById("batchnote").value.trim();if(!v){toast("先輸入備註內容");return}let n=0;document.querySelectorAll("tr[data-id]").forEach(function(tr){if(!picked.has(tr.dataset.id))return;tr.querySelector("input.note").value=v;n++});toast("已把備註套用到 "+n+" 列")};');
    html.push('document.getElementById("copyids").onclick=function(){const ids=Array.from(picked);if(!ids.length){toast("先勾選列");return}navigator.clipboard.writeText(ids.join(String.fromCharCode(10))).then(function(){toast("已複製 "+ids.length+" 個 ID")})};');
    html.push('document.getElementById("copycode").onclick=function(){const ids=Array.from(picked);if(!ids.length){toast("先勾選列");return}const groups={};ids.forEach(function(id){const c=by[id];const k=c.pageId||"?";(groups[k]=groups[k]||[]).push(id)});const pages=Object.keys(groups);const NL=String.fromCharCode(10);let code="(async () => {"+NL+"  const groups = "+JSON.stringify(groups)+";"+NL+"  const order = Object.keys(groups);"+NL+"  for (const pid of order) {"+NL+"    const page = await figma.getNodeByIdAsync(pid);"+NL+"    if (!page) continue;"+NL+"    await figma.setCurrentPageAsync(page);"+NL+"    const nodes = [];"+NL+"    for (const id of groups[pid]) { const n = await figma.getNodeByIdAsync(id); if (n) nodes.push(n); }"+NL+"    figma.currentPage.selection = nodes;"+NL+"    figma.viewport.scrollAndZoomIntoView(nodes);"+NL+"  }"+NL+"  const first = await figma.getNodeByIdAsync(order[0]);"+NL+"  if (first) await figma.setCurrentPageAsync(first);"+NL+"})();";if(pages.length>1){code+=NL+"// 跨 "+pages.length+" 個頁面：Figma 一次只能選同一頁，已停在第一頁；其餘頁面各自選過一輪"}navigator.clipboard.writeText(code).then(function(){toast("已複製（"+ids.length+" 個 ID / "+pages.length+" 頁）")})};');
    html.push('document.getElementById("barcopy").onclick=function(){const all=Array.prototype.slice.call(document.querySelectorAll("tr[data-id]"));md(rowsData(all.filter(function(tr){return picked.has(tr.dataset.id)})))};');
    html.push('build();</script></html>');

    const htmlPath = resolve(SCRATCH, 'review.html');
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, html.join('\n'), 'utf8');
    const queuePath = resolve(SCRATCH, 'review-queue.md');
    const queueRows = cards.map((c) => '| ' + c.id + ' | ' + c.page + ' | ' + c.copies + ' | ' + c.archetype + ' | ' + c.generation + ' | ' + c.predicted + ' | ' + Math.round(c.confidence * 100) + '% | ' + (c.headline || '').replace(/\|/g, '/').slice(0, 40) + ' |');
    const queueMd = ['| ID | 頁面 | 複本 | 版面 | 狀態 | 預測分類 | 信心 | 文案 |', '|---|---|---|---|---|---|---|---|'].concat(queueRows).join('\n') + '\n';
    writeFileSync(queuePath, queueMd, 'utf8');
    const lines = ['review  cards=' + cards.length + '  categories=' + categories.length, 'html  ' + htmlPath, 'md    ' + queuePath, 'open  open ' + htmlPath];
    OPT.out = null;
    emit({ command: 'review', cards: cards.length, html: htmlPath, md: queuePath }, lines.join('\n'));
    return;
  }

  if (cmd === 'propagate') {
    let raw = '';
    try {
      raw = readFileSync(OPT.input, 'utf8');
    } catch {
      fail('input not found: ' + OPT.input + ' (run sheets first)', 'not_found');
    }
    const cards = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    let labRaw = '';
    try {
      labRaw = readFileSync(OPT.screenLabels, 'utf8');
    } catch {
      fail('screen labels not found: ' + OPT.screenLabels);
    }
    const labels = (JSON.parse(labRaw) as { screens: ScreenLabel[] }).screens ?? [];
    const byId = new Map<string, Record<string, unknown>>();
    for (const c of cards) byId.set(String(c.id), c);

    const archs = ['page', 'overlay-panel', 'overlay'];
    const gens = ['new', 'old', 'unknown'];
    const typeSet = new Set<string>();
    for (const c of cards) for (const t of Object.keys((c.types as Record<string, number>) ?? {})) typeSet.add(t);
    const typeList = [...typeSet].sort().slice(0, 10);

    const vec = (c: Record<string, unknown>): number[] => {
      const nodes = Math.log1p(Number(c.nodes) || 0) / 8;
      const colors = Math.log1p(Number(c.colors) || 0) / 6;
      const tok = Math.min(1, Number(c.token_ratio) || 0);
      const fm = Math.log1p(Number(c.family_members) || 0) / 4;
      const depth = Math.min(1, (Number(c.depth) || 0) / 10);
      const t = (c.types as Record<string, number>) ?? {};
      const total = Object.values(t).reduce((s, v) => s + v, 0) || 1;
      const tvec = typeList.map((k) => (t[k] ?? 0) / total);
      const avec = archs.map((a) => (String(c.archetype) === a ? 1 : 0));
      const gvec = gens.map((g) => (String(c.generation) === g ? 1 : 0));
      return [3 * nodes, 0.5 * colors, 2 * tok, 0.5 * fm, 0.5 * depth]
        .concat(tvec.map((v) => v * 2), avec.map((v) => v * 3), gvec.map((v) => v * 0.5));
    };
    const dist = (a: number[], b: number[]): number => {
      let s = 0;
      for (let i = 0; i < a.length; i += 1) {
        const d = a[i] - b[i];
        s += d * d;
      }
      return Math.sqrt(s);
    };

    const train = labels.filter((l) => byId.has(l.id));
    const missing = labels.length - train.length;
    const trainIds = new Set(train.map((l) => l.id));
    const predict = (id: string, pool: ScreenLabel[]): { category: string; confidence: number; neighbors: string[] } => {
      const cv = vec(byId.get(id)!);
      const scored = pool
        .filter((l) => l.id !== id)
        .map((l) => ({ l, d: dist(cv, vec(byId.get(l.id)!)) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      if (scored.length === 0) return { category: '?', confidence: 0, neighbors: [] };
      const votes = new Map<string, number>();
      for (const s of scored) votes.set(s.l.category, (votes.get(s.l.category) ?? 0) + 1);
      let bestCat = scored[0].l.category;
      let bestVotes = 0;
      for (const [cat, n] of votes) {
        if (n > bestVotes) { bestVotes = n; bestCat = cat; }
      }
      return { category: bestCat, confidence: bestVotes / scored.length, neighbors: scored.map((s) => s.l.id) };
    };

    // Leave-one-out over the labeled set first: is this even viable?
    let ok = 0;
    const band = new Map<string, [number, number]>();
    const conf = new Map<string, [number, number]>();
    for (const l of train) {
      const p = predict(l.id, train);
      const hit = p.category === l.category;
      if (hit) ok += 1;
      const bk = p.confidence >= 0.99 ? 'unanimous' : p.confidence >= 0.6 ? 'majority' : 'split';
      const b = band.get(bk) ?? [0, 0];
      band.set(bk, [b[0] + (hit ? 1 : 0), b[1] + 1]);
      const cur = conf.get(l.category) ?? [0, 0];
      conf.set(l.category, [cur[0] + (hit ? 1 : 0), cur[1] + 1]);
    }
    const lines = ['propagate  labeled=' + train.length + '  unlabeled=' + (cards.length - train.length) + '  k=3'];
    lines.push('leave-one-out accuracy  ' + ok + '/' + train.length + ' = ' + Math.round(100 * ok / Math.max(1, train.length)) + '%');
    for (const [bk, [h, n]] of band) lines.push('  ' + pad(bk, 12) + h + '/' + n + ' = ' + Math.round(100 * h / Math.max(1, n)) + '%');
    for (const [cat, [h, n]] of [...conf.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 10)) {
      lines.push('  ' + pad(cat, 18) + h + '/' + n);
    }

    const predictions = cards
      .filter((c) => !trainIds.has(String(c.id)))
      .map((c) => {
        const p = predict(String(c.id), train);
        return { id: String(c.id), name: String(c.name ?? ''), archetype: String(c.archetype), category: p.category, confidence: Number(p.confidence.toFixed(2)), neighbors: p.neighbors };
      })
      .sort((a, b) => a.confidence - b.confidence);

    const outPath = resolve(SCRATCH, 'predictions.jsonl');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, predictions.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
    lines.push('');
    const bands = { split: 0, majority: 0, unanimous: 0 } as Record<string, number>;
    for (const p of predictions) {
      const band = p.confidence >= 0.99 ? 'unanimous' : p.confidence >= 0.6 ? 'majority' : 'split';
      bands[band] += 1;
    }
    lines.push('confidence bands  split(<0.6)=' + bands.split + '  majority=' + bands.majority + '  unanimous=' + bands.unanimous + '  total=' + predictions.length);
    lines.push('low-confidence predictions (showing ' + Math.min(OPT.top, predictions.length) + ' of ' + predictions.length + '):');
    lines.push(pad('id', 12) + pad('conf', 6) + pad('archetype', 15) + pad('category', 20) + 'name');
    for (const p of predictions.slice(0, OPT.top)) {
      lines.push(pad(p.id, 12) + pad(String(p.confidence), 6) + pad(p.archetype, 15) + pad(p.category.slice(0, 18), 20) + p.name.slice(0, 24));
    }
    lines.push('');
    lines.push('all predictions written to ' + outPath);
    OPT.out = null;
    emit({ command: 'propagate', loo: { ok, total: train.length }, predictions }, lines.join('\n'));
    return;
  }
  if (cmd === 'cluster') {
    let raw = '';
    try {
      raw = readFileSync(OPT.input, 'utf8');
    } catch {
      fail('input not found: ' + OPT.input + ' (run sheets first)', 'not_found');
    }
    const allCards = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const cards = OPT.archetype ? allCards.filter((c) => String(c.archetype) === OPT.archetype) : allCards;
    if (cards.length < OPT.k * 2) fail('not enough cards (' + cards.length + ') for k=' + OPT.k);

    const typeSet = new Set<string>();
    const famSet = new Set<string>();
    for (const c of cards) {
      for (const t of Object.keys((c.types as Record<string, number>) ?? {})) typeSet.add(t);
      const f = (c.fonts_top as Array<[string, number]>) ?? [];
      if (f[0]) famSet.add(String(f[0][0]).split(' ')[0]);
    }
    const typeList = [...typeSet].sort();
    const famList = [...famSet].sort();

    const vec = (c: Record<string, unknown>): number[] => {
      const nodes = Math.log1p(Number(c.nodes) || 0) / 8;
      const colors = Math.log1p(Number(c.colors) || 0) / 6;
      const fm = Math.log1p(Number(c.family_members) || 0) / 4;
      const tok = Math.min(1, Number(c.token_ratio) || 0);
      const depth = Math.min(1, (Number(c.depth) || 0) / 10);
      const t = (c.types as Record<string, number>) ?? {};
      const total = Object.values(t).reduce((s, v) => s + v, 0) || 1;
      const tvec = typeList.slice(0, 8).map((k) => (t[k] ?? 0) / total);
      const f = (c.fonts_top as Array<[string, number]>) ?? [];
      const dom = f[0] ? String(f[0][0]).split(' ')[0] : '';
      const fvec = famList.map((x) => (x === dom ? 1 : 0));
      return [3 * nodes, 0.5 * colors, 0.5 * fm, 2 * tok, 0.5 * depth].concat(tvec.map((v) => v * 2), fvec);
    };

    const X = cards.map(vec);
    const dim = X[0].length;
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const dist2 = (a: number[], b: number[]): number => {
      let s = 0;
      for (let i = 0; i < dim; i += 1) {
        const d = a[i] - b[i];
        s += d * d;
      }
      return s;
    };

    let bestAssign: number[] = [];
    let bestInertia = Infinity;
    for (let restart = 0; restart < 8; restart += 1) {
      const centroids: number[][] = [];
      const used = new Set<number>();
      while (centroids.length < OPT.k) {
        const i = Math.floor(rnd() * X.length);
        if (used.has(i)) continue;
        used.add(i);
        centroids.push(X[i].slice());
      }
      const assign = new Array<number>(X.length).fill(-1);
      for (let iter = 0; iter < 30; iter += 1) {
        let moved = 0;
        for (let i = 0; i < X.length; i += 1) {
          let bi = 0;
          let bd = Infinity;
          for (let c = 0; c < centroids.length; c += 1) {
            const d = dist2(X[i], centroids[c]);
            if (d < bd) { bd = d; bi = c; }
          }
          if (assign[i] !== bi) { assign[i] = bi; moved += 1; }
        }
        const sums = centroids.map(() => new Array<number>(dim).fill(0));
        const counts = new Array<number>(centroids.length).fill(0);
        for (let i = 0; i < X.length; i += 1) {
          const c = assign[i];
          counts[c] += 1;
          for (let d = 0; d < dim; d += 1) sums[c][d] += X[i][d];
        }
        for (let c = 0; c < centroids.length; c += 1) {
          if (counts[c] === 0) continue;
          for (let d = 0; d < dim; d += 1) centroids[c][d] = sums[c][d] / counts[c];
        }
        if (moved === 0) break;
      }
      let inertia = 0;
      for (let i = 0; i < X.length; i += 1) inertia += dist2(X[i], centroids[assign[i]]);
      if (inertia < bestInertia) { bestInertia = inertia; bestAssign = assign; }
    }

    const clusters: Array<{ idx: number; cards: Array<Record<string, unknown>> }> = [];
    for (let c = 0; c < OPT.k; c += 1) clusters.push({ idx: c, cards: [] });
    for (let i = 0; i < cards.length; i += 1) clusters[bestAssign[i]].cards.push(cards[i]);
    clusters.sort((a, b) => b.cards.length - a.cards.length);

    const lines = ['cluster  k=' + OPT.k + '  points=' + cards.length + '  inertia=' + bestInertia.toFixed(1)];
    const out = clusters.map((cl) => {
      const nodes = cl.cards.map((c) => Number(c.nodes) || 0).sort((a, b) => a - b);
      const tok = cl.cards.reduce((s, c) => s + (Number(c.token_ratio) || 0), 0) / Math.max(1, cl.cards.length);
      const hashes = new Map<string, number>();
      const names = new Map<string, number>();
      const gens = new Map<string, number>();
      for (const c of cl.cards) {
        const h = String(c.hash).slice(0, 8);
        hashes.set(h, (hashes.get(h) ?? 0) + 1);
        const n = String(c.name || '(unnamed)');
        names.set(n, (names.get(n) ?? 0) + 1);
        const g = String(c.generation);
        gens.set(g, (gens.get(g) ?? 0) + 1);
      }
      const topHash = [...hashes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const topName = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      lines.push('');
      lines.push('cluster ' + cl.idx + '  n=' + cl.cards.length +
        '  nodes ' + nodes[0] + '-' + nodes[nodes.length - 1] +
        '  tokens ' + (tok * 100).toFixed(1) + '%  gen ' + [...gens.entries()].map(([k, v]) => k + ':' + v).join(','));
      lines.push('  names  ' + topName.map(([k, v]) => k.slice(0, 18) + ' x' + v).join(' | '));
      lines.push('  hashes ' + topHash.map(([k, v]) => k + ' x' + v).join(' '));
      lines.push('  sample ' + cl.cards.slice(0, 6).map((c) => String(c.id)).join(' '));
      return {
        cluster: cl.idx,
        size: cl.cards.length,
        nodesRange: [nodes[0], nodes[nodes.length - 1]],
        tokenMean: Number(tok.toFixed(4)),
        generation: Object.fromEntries(gens),
        topNames: topName,
        topHashes: topHash,
        ids: cl.cards.map((c) => String(c.id)),
      };
    });
    const outPath = resolve(SCRATCH, 'clusters.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ k: OPT.k, input: OPT.input, clusters: out }, null, 2), 'utf8');
    lines.push('');
    lines.push('clusters written to ' + outPath);
    OPT.out = null;
    emit({ command: 'cluster', k: OPT.k, clusters: out }, lines.join('\n'));
    return;
  }
  if (cmd === 'sheet') {
    const id = positional[0] ?? fail('sheet needs a node id', 'missing_input');
    if (!g.nodes.has(id)) fail('node not found: ' + id, 'not_found');
    let labels: LabelEntry[] = [];
    try {
      labels = loadLabels(OPT.labels).labels;
    } catch {
      labels = [];
    }
    const card = buildSheetCard(g, OPT.db, id, { labels, floor: OPT.floor });
    const lines = [
      'sheet  ' + card.id + '  (' + card.name + ')',
      'page ' + card.page + '  type ' + card.type + '  ' + card.bbox.w + 'x' + card.bbox.h + '  archetype ' + card.archetype,
      'structure  hash=' + card.structure.hash + '  nodes=' + card.structure.nodes + '  depth=' + card.structure.depth +
        '  family=' + card.structure.familyMembers + '  axes=' + card.structure.familyAxes,
      'style      colors=' + card.style.paletteSize + '  tokens=' + card.style.tokens + '/' + card.structure.nodes +
        ' (' + (card.style.tokenRatio * 100).toFixed(1) + '%)',
      'palette    ' + fmtMap(new Map(card.style.paletteTop), 6),
      'type       ' + fmtMap(new Map(card.style.fontsTop), 3),
      'copy       ' + (card.copy.headline || '(none)'),
      'variant    axis=' + (card.variants.axis ?? '-') + '  siblings=' + card.variants.siblings +
        (card.variants.differs[0] ? '  differs: ' + card.variants.differs[0].slice(0, 40) : ''),
      'generation ' + card.labels.generation,
      '',
      'not judgeable from the AST: ' + card.limits.join(', ') + '.',
    ];
    emit(card, lines.join('\n'));
    return;
  }

  if (cmd === 'find') {
    const like = positional[0] ?? fail('find needs a node id', 'missing_input');
    if (!g.nodes.has(like)) fail('node not found: ' + like, 'not_found');
    const f = findSimilar(g, OPT.db, like, OPT.top);
    const lines = ['find  ' + f.like + '  (' + f.name + ')  candidates=' + f.candidates];
    const section = (title: string, list: FindRow[], score: (r: FindRow) => string): void => {
      lines.push('');
      lines.push(title + '  ' + list.length);
      for (const r of list) {
        lines.push('  ' + pad(r.id, 12) + pad(score(r), 8) + pad(String(r.nodes), 6) + pad(r.page.slice(0, 12), 14) + r.name.slice(0, 34));
      }
    };
    section('L1 exact structure', f.exact, () => '1.000');
    section('L2 near structure', f.near, (r) => r.struct.toFixed(3));
    section('L3 style only', f.styleOnly, (r) => r.style.toFixed(3));
    lines.push('');
    lines.push('unranked below thresholds: ' + f.unranked);
    emit(f, lines.join('\n'));
    return;
  }

  if (cmd === 'derive') {
    const lf = loadLabels(OPT.labels);
    const groups = groupStats(g, OPT.db, lf.labels);
    const lines = ['derive  labels=' + lf.labels.length + '  groups=' + groups.length + '  source=' + OPT.labels];
    for (const gp of groups) {
      lines.push('');
      lines.push(gp.label + '  n=' + gp.count + '  tokenRatio=' + (gp.tokenRatio * 100).toFixed(1) + '%');
      const dom = [...gp.fontCounts.entries()].sort((x, y) => y[1] - x[1])[0];
      const domTotal = [...gp.fontCounts.values()].reduce((s, v) => s + v, 0);
      lines.push('  fonts   ' + [...gp.families].sort().join(', '));
      lines.push('  dom     ' + (dom ? dom[0] + ' ' + (100 * dom[1] / Math.max(1, domTotal)).toFixed(0) + '%' : '-'));
      lines.push('  palette ' + [...gp.palette].sort().slice(0, 10).join(' ') + (gp.palette.size > 10 ? ' ...(' + gp.palette.size + ')' : ''));
      lines.push('  radii   ' + [...gp.radii].sort().slice(0, 10).join(', '));
    }
    const seps: unknown[] = [];
    if (groups.length >= 2) {
      lines.push('');
      lines.push('separability');
      for (let i = 0; i < groups.length; i += 1) {
        for (let j = i + 1; j < groups.length; j += 1) {
          const a = groups[i];
          const b = groups[j];
          const f = jaccard(a.families, b.families);
          const p = jaccard(a.palette, b.palette);
          const r = jaccard(a.radii, b.radii);
          const t = Math.abs(a.tokenRatio - b.tokenRatio);
          seps.push({ a: a.label, b: b.label, fontJaccard: f, paletteJaccard: p, radiusJaccard: r, tokenDelta: t });
          lines.push('  ' + a.label + ' vs ' + b.label +
            '  fonts=' + f.toFixed(3) +
            '  palette=' + p.toFixed(3) +
            '  radii=' + r.toFixed(3) +
            '  tokenDelta=' + t.toFixed(3));
        }
      }
    }
    lines.push('');
    lines.push('leave-one-out');
    let looTotal = 0;
    let looOk = 0;
    let looSkipped = 0;
    const looRows: string[] = [];
    for (const e of lf.labels) {
      const rest = lf.labels.filter((x) => x.id !== e.id);
      const gs = groupStats(g, OPT.db, rest);
      if (gs.length < groups.length) {
        looSkipped += 1;
        continue;
      }
      const res = classifyWith(g, OPT.db, e.id, gs);
      const decided = decideLabel(res, OPT.floor);
      const best = decided.best;
      const verdict = decided.verdict;
      looTotal += 1;
      if (verdict === e.label) looOk += 1;
      looRows.push('  ' + e.id.padEnd(12) + ' expected=' + pad(e.label, 5) + ' got=' + pad(verdict, 8) +
        ' best=' + best.toFixed(3) + ' margin=' + res.margin.toFixed(3));
    }
    if (looTotal === 0) {
      lines.push('  insufficient — each class has a single label (' + looSkipped + ' skipped); add more labels to validate.');
    } else {
      lines.push('  accuracy ' + looOk + '/' + looTotal + (looSkipped > 0 ? '  skipped=' + looSkipped : ''));
      for (const r of looRows) lines.push(r);
    }
    lines.push('');
    lines.push('weights: fontShare 0.40 · token(log) 0.35 · palette 0.10 · radius 0.15');
    lines.push('abstain: margin < 0.10, or best < ' + OPT.floor.toFixed(2) + ' with margin < 0.25');
    emit(
      {
        command: 'derive',
        source: OPT.labels,
        groups: groups.map((gp) => ({
          label: gp.label,
          count: gp.count,
          tokenRatio: Number(gp.tokenRatio.toFixed(4)),
          fonts: [...gp.families].sort(),
          palette: [...gp.palette].sort(),
          radii: [...gp.radii].sort(),
        })),
        separability: seps,
      },
      lines.join('\n'),
    );
    return;
  }

  if (cmd === 'classify') {
    const id = positional[0] ?? fail('classify needs a node id');
    if (!g.nodes.has(id)) fail('node not found: ' + id, 'not_found');
    const lf = loadLabels(OPT.labels);
    const groups = groupStats(g, OPT.db, lf.labels);
    const res = classifyWith(g, OPT.db, id, groups);
    const node = g.nodes.get(id)!;
    const decided = decideLabel(res, OPT.floor);
    const best = decided.best;
    const verdict = decided.verdict;
    const lines = [
      'classify  ' + id + '  (' + node.name + ')',
      'verdict   ' + verdict.toUpperCase() + '   best=' + best.toFixed(3) +
        '  margin=' + res.margin.toFixed(3) + '  floor=' + OPT.floor.toFixed(2),
      '',
      pad('group', 8) + pad('score', 7) + pad('font', 7) + pad('token', 7) + pad('palette', 8) + 'radius',
    ];
    for (const v of res.votes) {
      lines.push(
        pad(v.label, 8) + pad(v.total.toFixed(3), 7) + pad(v.font.toFixed(3), 7) +
          pad(v.token.toFixed(3), 7) + pad(v.palette.toFixed(3), 8) + v.radius.toFixed(3),
      );
    }
    if (verdict === 'unknown') {
      lines.push('');
      lines.push(best < OPT.floor
        ? 'best score below the floor — this node does not look like either labeled generation.'
        : 'margin below 0.10 — the rules cannot separate the two generations for this node.');
    }
    emit({ command: 'classify', id, name: node.name, verdict, best: Number(best.toFixed(4)), margin: Number(res.margin.toFixed(4)), floor: OPT.floor, votes: res.votes }, lines.join('\n'));
    return;
  }

  if (cmd === 'scan') {
    const lf = loadLabels(OPT.labels);
    const groups = groupStats(g, OPT.db, lf.labels);
    const candidates: string[] = [];
    for (const [id, n] of g.nodes) {
      if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') continue;
      const w = n.bbox_w ?? 0;
      const h = n.bbox_h ?? 0;
      if (Math.abs(w - 390) > 4 || Math.abs(h - 844) > 6) continue;
      candidates.push(id);
    }
    const set = new Set(candidates);
    const roots = candidates.filter((id) => {
      let p = g.nodes.get(id)?.parent_id ?? null;
      while (p) {
        if (set.has(p)) return false;
        p = g.nodes.get(p)?.parent_id ?? null;
      }
      return true;
    });
    const buckets = new Map<string, Array<{ id: string; name: string; best: number; margin: number; nodes: number }>>();
    for (const id of roots) {
      const sub = g.subtree(id);
      if (sub.length < 40) continue;
      const res = classifyWith(g, OPT.db, id, groups);
      const n = g.nodes.get(id)!;
      const decided = decideLabel(res, OPT.floor);
      const best = decided.best;
      const verdict = decided.verdict;
      const bucket = buckets.get(verdict);
      const row = { id, name: n.name.slice(0, 40), best: Number(best.toFixed(3)), margin: Number(res.margin.toFixed(3)), nodes: sub.length };
      if (bucket) bucket.push(row);
      else buckets.set(verdict, [row]);
    }
    const order = [...buckets.keys()].sort();
    const lines = ['scan  screens=' + roots.length + '  labels=' + lf.labels.length];
    for (const k of order) {
      const rows = buckets.get(k)!;
      lines.push('');
      lines.push(k.toUpperCase() + '  ' + rows.length);
      for (const r of rows.slice(0, OPT.top)) {
        lines.push('  ' + r.id.padEnd(12) + pad(String(r.nodes), 6) + pad(r.best.toFixed(3), 7) + pad(r.margin.toFixed(3), 7) + r.name);
      }
      if (rows.length > OPT.top) lines.push('  ... ' + (rows.length - OPT.top) + ' more');
    }
    emit(
      {
        command: 'scan',
        screens: roots.length,
        buckets: Object.fromEntries(order.map((k) => [k, buckets.get(k)!.map((r) => r.id)])),
        detail: Object.fromEntries(order.map((k) => [k, buckets.get(k)])),
      },
      lines.join('\n'),
    );
    return;
  }


  if (cmd === 'variants') {
    const found: DerivedFamily[] = [];
    for (const hash of g.byHash.keys()) {
      const members = g.topLevelMembers(hash).filter((m) => g.subtree(m).length >= 120);
      if (members.length < OPT.minMembers || members.length > 60) continue;
      const fam = deriveFamilyAxes(g, members, OPT.hint);
      if (fam.axes.length < 2) continue;
      fam.family = hash.slice(0, 12);
      found.push(fam);
    }
    found.sort((a, b) => b.members - a.members);
    const lines = ['variants  families=' + found.length + '  minMembers=' + OPT.minMembers + '  hint=' + (OPT.hint ? 'on' : 'off')];
    for (const fam of found.slice(0, OPT.top)) {
      lines.push('');
      lines.push(fam.family + '  ' + fam.nameHint.slice(0, 32) + '  members=' + fam.members + '  axes=' + fam.axes.length);
      for (const a of fam.axes) {
        lines.push('  ' + pad(a.key, 18) + pad('n=' + String(a.members.length), 6) + pad(a.size, 9) + pad('d' + String(a.depth), 5) +
          (OPT.hint ? pad(a.hint || '-', 10) : '') + (a.samples[0] ?? '').slice(0, 36));
      }
      if (fam.unresolved.length > 0) lines.push('  unresolved: ' + fam.unresolved.length);
    }
    const payload = { version: 1, generated_from: OPT.db, families: found };
    const outPath = OPT.out ? resolve(ROOT, OPT.out) : resolve(SCRATCH, 'variants.json');
    if (!(outPath === SCRATCH || outPath.startsWith(SCRATCH + sep))) {
      fail('--out must stay inside .scratch/ (variants are derived, not source)');
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    lines.push('');
    lines.push('derived axes written to ' + outPath + ' (' + found.length + ' families)');
    emit(payload, lines.join('\n'));
    return;
  }

  if (cmd === 'variant') {
    const id = positional[0] ?? fail('variant needs a node id');
    if (!g.nodes.has(id)) fail('node not found: ' + id, 'not_found');
    const hash = g.hash.get(id)!;
    const members = g.topLevelMembers(hash).filter((m) => g.subtree(m).length >= 120);
    if (members.length < 2) fail('this node has no sibling variants (family size ' + members.length + ')');
    const fam = deriveFamilyAxes(g, members, OPT.hint);
    const hit = fam.axes.filter((a) => a.members.indexOf(id) !== -1)[0];
    const node = g.nodes.get(id)!;
    const lines = ['variant  ' + id + '  (' + node.name + ')',
      'family   ' + hash.slice(0, 12) + '  members=' + members.length + '  axes=' + fam.axes.length + '  unresolved=' + fam.unresolved.length];
    if (hit) {
      lines.push('axis     ' + hit.key + '  size=' + hit.size + '  depth=' + hit.depth +
        (OPT.hint && hit.hint ? '  hint=' + hit.hint : ''));
      lines.push('differs  ' + (hit.samples.join(' | ') || '(no unique copy)'));
    } else {
      lines.push('axis     (unresolved)');
      lines.push('this member matches no single switch; the family may need another axis.');
    }
    lines.push('');
    lines.push(pad('axis', 14) + pad('members', 9) + 'sample');
    for (const a of fam.axes) {
      lines.push('  ' + pad(a.key, 12) + pad(String(a.members.length), 9) + (a.samples[0] ?? '').slice(0, 44));
    }
    emit({ command: 'variant', id, family: hash.slice(0, 12), axis: hit ? hit.key : null, samples: hit ? hit.samples : [], axes: fam.axes }, lines.join('\n'));
    return;
  }
}

try {
  main();
} catch (err) {
  const e = err instanceof ToolError
    ? err
    : new ToolError('internal', err instanceof Error ? err.message : String(err));
  if (OPT.json) {
    console.log(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, fix: e.fix } }, null, 2));
  } else {
    console.error('error: ' + e.message + (e.fix ? '\n  fix: ' + e.fix : ''));
  }
  process.exitCode = 1;
}
