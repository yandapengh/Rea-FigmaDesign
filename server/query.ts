import { createHash } from 'node:crypto';
import { AstGraphDB } from './db';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import {
  Graph, profileOf, slotsOf, typeHist, cosine, jaccard, topEntries,
  archetypeOf, headlineOf, isChrome, findScreenRootCandidates,
} from './core/graph';
import { resolveProject } from './core/projects';
import {
  loadLabels, groupStats, classifyWith, decideLabel, deriveFamilyAxes,
  tryLoadScreenLabelsV2,
  type LabelEntry, type GroupStats, type DerivedFamily,
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
  dbExplicit: false,
  project: null as string | null,
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
  screenLabels: resolve(ROOT, 'labels/screens-v2.json'),
  screenLabelsExplicit: false,
  screenSpec: undefined as ReturnType<typeof resolveProject>['config']['screenSpec'] | undefined,
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
    else if (a === '--project') OPT.project = argv[++i] ?? fail('--project needs a value');
    else if (a === '--db') { OPT.db = resolve(ROOT, argv[++i] ?? fail('--db needs a value')); OPT.dbExplicit = true; }
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
    else if (a === '--screen-labels') { OPT.screenLabels = resolve(ROOT, argv[++i] ?? fail('--screen-labels needs a value')); OPT.screenLabelsExplicit = true; }
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
  { name: 'verify-source', summary: 'every id in labels/screens-v2.json must exist in the sample', args: '', mutates: false, writes: false },
];

const MODES = ['manifest', 'family', 'profile', 'diff', 'find', 'derive', 'classify', 'scan', 'variants', 'variant', 'sheet', 'sheets', 'cluster', 'verify-source'];

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
  lines.push('labels     labels/screens-v2.json is source (use MCP apply_labels or review:board)');
  lines.push('examples   npm run query -- sheet 33:27783');
  lines.push('           npm run query -- verify-source');
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

  if (OPT.project || OPT.dbExplicit) {
    const resolved = resolveProject(ROOT, {
      project: OPT.project || undefined,
      dbPath: OPT.dbExplicit ? OPT.db : undefined,
    });
    if (!OPT.dbExplicit) OPT.db = resolved.dbPath;
    if (!OPT.screenLabelsExplicit) OPT.screenLabels = resolved.labelsPath;
    OPT.screenSpec = resolved.config.screenSpec;
  } else {
    const resolved = resolveProject(ROOT, {});
    OPT.screenLabels = resolved.labelsPath;
    OPT.screenSpec = resolved.config.screenSpec;
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
    const roots = findScreenRootCandidates(g, OPT.screenSpec);

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
  if (cmd === 'verify-source') {
    const problems: Array<Record<string, unknown>> = [];
    const v2Doc = tryLoadScreenLabelsV2(OPT.screenLabels);
    let checkedLabels = 0;
    if (v2Doc) {
      for (const s of v2Doc.screens) {
        checkedLabels += 1;
        if (!g.nodes.has(s.id)) {
          problems.push({ source: 'labels/screens-v2.json', id: s.id, problem: 'missing in sample' });
        }
      }
    }
    const lines = [
      'verify-source  every id in labels/screens-v2.json must exist in the SQLite graph',
      'checked  labels_v2=' + checkedLabels + (v2Doc ? '' : ' (no labels/screens-v2.json yet)'),
    ];
    for (const p of problems.slice(0, 20)) lines.push('  FAIL  ' + p.source + ' ' + String(p.id) + '  ' + p.problem);
    lines.push('');
    if (problems.length > 0) {
      lines.push('RESULT: FAIL  (' + problems.length + ' mismatches)');
      OPT.out = null;
      emit({ command: 'verify-source', checked: { labelsV2: checkedLabels }, problems }, lines.join('\n'));
      process.exitCode = 1;
      return;
    }
    lines.push('RESULT: OK — every id exists in the sample');
    OPT.out = null;
    emit({ command: 'verify-source', checked: { labelsV2: checkedLabels }, problems: [] }, lines.join('\n'));
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
    const roots = findScreenRootCandidates(g);
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
