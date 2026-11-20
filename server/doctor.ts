/// <reference lib="es2022" />
/**
 * Preflight doctor. Run before any query-layer work.
 *
 * It answers one question: is this checkout in a state where the pipeline and the
 * query layer can be trusted? Exit code 1 means "do not proceed" and every failure
 * prints the concrete fix.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import Database = require('better-sqlite3');

const ROOT = resolve(__dirname, '..');
const SCRATCH = resolve(ROOT, '.scratch');
let failures = 0;
let warnings = 0;

function ok(msg: string): void {
  console.log('  ok    ' + msg);
}
function warn(msg: string, fix?: string): void {
  warnings += 1;
  console.log('  warn  ' + msg);
  if (fix) console.log('        fix: ' + fix);
}
function bad(msg: string, fix?: string): void {
  failures += 1;
  console.log('  FAIL  ' + msg);
  if (fix) console.log('        fix: ' + fix);
}
function section(name: string): void {
  console.log('');
  console.log(name);
}

function checkNode(): void {
  section('runtime');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok('node ' + process.versions.node);
  else bad('node ' + process.versions.node + ' is too old', 'use node 20 or newer');
}

function inspectDb(path: string, label: string): { nodes: number; ok: boolean } | null {
  if (!existsSync(path)) {
    bad(label + ' missing: ' + path, 'run the Figma extraction, or restore a frozen sample');
    return null;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const integrity = db.prepare('pragma quick_check').get() as Record<string, unknown>;
    const value = Object.values(integrity)[0];
    if (String(value).toLowerCase() !== 'ok') {
      bad(label + ' failed quick_check', 're-extract: the file is corrupted');
      return null;
    }
    const nodes = (db.prepare('select count(*) as n from nodes').get() as { n: number }).n;
    const meta = db.prepare('select file_name, extracted_at, total_nodes from file_meta limit 1').get() as
      | { file_name?: string; extracted_at?: string; total_nodes?: number }
      | undefined;
    ok(label + '  ' + nodes.toLocaleString() + ' nodes  ' + (meta && meta.file_name ? meta.file_name : '') + '  ' + (meta && meta.extracted_at ? meta.extracted_at : ''));
    return { nodes, ok: true };
  } catch (err) {
    bad(label + ' unreadable: ' + (err instanceof Error ? err.message : String(err)), 'check the file, or delete it and re-extract');
    return null;
  } finally {
    if (db) db.close();
  }
}

function checkData(): void {
  section('data');
  const live = (() => {
    const dataRoot = resolve(ROOT, 'data');
    if (!existsSync(dataRoot)) return resolve(dataRoot, 'rea-figma.sqlite');
    let best = '';
    let bestTime = 0;
    for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = resolve(dataRoot, entry.name, 'graph.sqlite');
      if (!existsSync(candidate)) continue;
      const t = statSync(candidate).mtimeMs;
      if (t > bestTime) { bestTime = t; best = candidate; }
    }
    return best || resolve(dataRoot, 'rea-figma.sqlite');
  })();
  if (!existsSync(live)) {
    warn('no live db yet (fresh checkout)', 'run the Figma extraction: npm run start:server, then the plugin');
  } else {
    const liveResult = inspectDb(live, 'live db');
    if (liveResult && liveResult.nodes === 0) bad('live db has no nodes', 're-run the extraction');
  }

  const samplesDir = resolve(ROOT, 'data/samples');
  if (!existsSync(samplesDir)) {
    warn('no data/samples directory', 'freeze a run first: sqlite3 data/rea-figma.sqlite ".backup \'data/samples/<id>.sqlite\'"');
    return;
  }
  const samples = readdirSync(samplesDir).filter((f) => f.endsWith('.sqlite'));
  if (samples.length === 0) {
    warn('no frozen samples', 'freeze one before analysing: see PLAN.md section 5');
    return;
  }
  ok(samples.length + ' frozen sample(s): ' + samples.slice(0, 3).join(', ') + (samples.length > 3 ? ' ...' : ''));
  for (const s of samples.slice(0, 3)) {
    const res = inspectDb(resolve(samplesDir, s), '  sample ' + s);
    if (res && res.nodes === 0) bad('sample ' + s + ' has no nodes', 're-freeze it');
  }
}

function checkLabels(): void {
  section('labels');
  const files: Array<[string, string, (v: unknown) => string | null]> = [
    ['labels/style.json', 'style labels', (v) => {
      const d = v as { labels?: unknown[] };
      if (!Array.isArray(d.labels)) return 'no labels array';
      for (const l of d.labels) {
        const e = l as { id?: string; label?: string };
        if (!e.id || !e.label) return 'entry missing id/label';
      }
      return null;
    }],
    ['labels/screens.json', 'screen labels', (v) => {
      const d = v as { screens?: unknown[] };
      if (!Array.isArray(d.screens)) return 'no screens array';
      for (const s of d.screens) {
        const e = s as { id?: string; category?: string; kind?: string };
        if (!e.id || !e.category) return 'entry missing id/category';
        if (e.kind !== 'page' && e.kind !== 'dialog') return 'entry kind must be page|dialog';
      }
      return null;
    }],
  ];
  try {
    const style = JSON.parse(readFileSync(resolve(ROOT, 'labels/style.json'), 'utf8')) as { labels?: unknown[] };
    const screens = JSON.parse(readFileSync(resolve(ROOT, 'labels/screens.json'), 'utf8')) as { screens?: unknown[]; taxonomy?: { page?: unknown[]; dialog?: unknown[] } };
    if ((style.labels ?? []).length === 0 && (screens.screens ?? []).length === 0) {
      warn('labels are empty (fresh checkout)', 'fill taxonomy and label screens after the first extraction');
    }
  } catch {
    // validation below reports the real problem
  }
  for (const [rel, name, validate] of files) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) {
      warn(name + ' missing (' + rel + ')', 'classification will fall back to unlabelled');
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
      const problem = validate(parsed);
      if (problem) bad(name + ' invalid: ' + problem, 'fix ' + rel + ' (it is tracked source)');
      else ok(name + ' ok');
    } catch (err) {
      bad(name + ' is not valid JSON: ' + (err instanceof Error ? err.message : String(err)), 'restore ' + rel + ' from git');
    }
  }
}

function checkScratch(): void {
  section('workspace');
  try {
    mkdirSync(SCRATCH, { recursive: true });
    const probe = resolve(SCRATCH, '.doctor-probe');
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
    ok('.scratch writable');
  } catch (err) {
    bad('.scratch not writable: ' + (err instanceof Error ? err.message : String(err)), 'check permissions on the checkout');
  }
  try {
    const dirty = execSync('git status --porcelain labels', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (dirty) warn('labels/ has uncommitted changes', 'commit them, or the next run will compare against a different baseline');
    else ok('labels/ clean');
  } catch {
    warn('not a git checkout (or git unavailable)', 'version the labels directory somewhere');
  }
}

function checkScripts(): void {
  section('commands');
  const pkgPath = resolve(ROOT, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    for (const name of ['start:server', 'sync', 'query', 'typecheck', 'test:pipeline', 'test:parity', 'test:mcp', 'test:pages']) {
      if (pkg.scripts && pkg.scripts[name]) ok('npm run ' + name);
      else bad('missing npm script: ' + name, 'restore it in package.json');
    }
  } catch {
    bad('package.json unreadable', 'restore it from git');
  }
}

function main(): void {
  console.log('Rea-FigmaDesign doctor  ·  checkout ' + ROOT);
  checkNode();
  checkData();
  checkLabels();
  checkScratch();
  checkScripts();
  console.log('');
  if (failures > 0) {
    console.log('RESULT: FAIL  (' + failures + ' blocking, ' + warnings + ' warnings)');
    process.exit(1);
  }
  console.log('RESULT: OK' + (warnings > 0 ? '  (' + warnings + ' warnings)' : ''));
}

main();
