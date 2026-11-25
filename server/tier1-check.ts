/// <reference lib="es2022" />
/** Tier 1 / z-order regression on a full-file graph: screen rule, Merkle dedupe, archetypes. */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AstGraphDB } from './db';
import { Graph, archetypeOf, findScreenRootCandidates } from './core/graph';

const ROOT = resolve(__dirname, '..');
let dbPath = '';
for (const a of process.argv.slice(2)) if (!a.startsWith('--')) dbPath = resolve(ROOT, a);
if (!dbPath) dbPath = AstGraphDB.resolveLatestGraphDb(ROOT) ?? '';
if (!dbPath || !existsSync(dbPath)) { console.error('no database'); process.exit(1); }

const started = Date.now();
const g = new Graph(dbPath);
const roots = findScreenRootCandidates(g);
const screens = roots.filter((id) => g.subtree(id).length >= 40);
const hashes = new Map<string, number>();
const archetypes = { page: 0, 'overlay-panel': 0, overlay: 0, other: 0 };
for (const id of screens) {
  const h = g.hash.get(id) ?? '';
  hashes.set(h, (hashes.get(h) ?? 0) + 1);
  const a = archetypeOf(g, id);
  if (a in archetypes) (archetypes as Record<string, number>)[a] += 1; else archetypes.other += 1;
}
const unique = hashes.size;
const top = [...hashes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
const ms = Date.now() - started;
console.log('tier1  db=' + dbPath);
console.log('nodes=' + g.nodes.size.toLocaleString('en-US') + '  candidates=' + roots.length + '  screens=' + screens.length);
console.log('unique hashes=' + unique + '  dedupe=' + (screens.length / Math.max(1, unique)).toFixed(2) + 'x');
console.log('archetypes  page=' + archetypes.page + '  overlay-panel=' + archetypes['overlay-panel'] + '  overlay=' + archetypes.overlay + '  other=' + archetypes.other);
console.log('top families: ' + top.map(([h, c]) => h.slice(0, 8) + '×' + c).join('  '));
console.log('elapsed=' + (ms / 1000).toFixed(1) + 's');
if (screens.length === 0 || hashes.size === 0 || archetypes.other > 0) {
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('RESULT: OK — screen rule, Merkle hash and z-order archetypes all ran');
